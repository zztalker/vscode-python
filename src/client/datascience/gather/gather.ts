import { DataflowAnalyzer } from '@msrvida/python-program-analysis';
import { JupyterCell as ICell, LabCell } from '@msrvida/python-program-analysis/lib/cell';
import { CellSlice } from '@msrvida/python-program-analysis/lib/cellslice';
import { ExecutionLogSlicer, SlicedExecution } from '@msrvida/python-program-analysis/lib/log-slicer';

import { LocationSet } from '@msrvida/python-program-analysis/lib/slice';
import { inject, injectable } from 'inversify';
import { traceInfo } from '../../common/logger';
import { IConfigurationService } from '../../common/types';
import { noop } from '../../common/utils/misc';
import { concatMultilineString } from '../common';
import { CellState, ICell as IVscCell, IGatherExecution, INotebookExecutionLogger } from '../types';

/**
 * An adapter class to wrap the code gathering functionality from [microsoft/python-program-analysis](https://www.npmjs.com/package/@msrvida/python-program-analysis).
 */
@injectable()
export class GatherExecution implements IGatherExecution, INotebookExecutionLogger {
    private _executionSlicer: ExecutionLogSlicer;
    private dataflowAnalyzer: DataflowAnalyzer;

    constructor(
        @inject(IConfigurationService) private configService: IConfigurationService
    ) {
        const rules = this.configService.getSettings().datascience.gatherRules;
        this.dataflowAnalyzer = new DataflowAnalyzer(rules); // Pass in a sliceConfiguration object, or not
        this._executionSlicer = new ExecutionLogSlicer(this.dataflowAnalyzer);
        traceInfo('Gathering tools have been activated');
    }

    public async preExecute(_vscCell: IVscCell, _silent: boolean): Promise<void> {
        // This function is just implemented here for compliance with the INotebookExecutionLogger interface
        noop();
    }

    public async postExecute(vscCell: IVscCell, _silent: boolean): Promise<void> {
        // Don't log if vscCell.data.source is an empty string. Original Jupyter extension also does this.
        if (vscCell.data.source !== '') {
            // Convert IVscCell to IGatherCell
            const cell = convertVscToGatherCell(vscCell) as LabCell;

            // Call internal logging method
            this._executionSlicer.logExecution(cell);
        }
    }

    /**
     * For a given code cell, returns a string representing a program containing all the code it depends on.
     */
    public gatherCode(vscCell: IVscCell): string {
        // sliceAllExecutions does a lookup based on executionEventId
        const cell = convertVscToGatherCell(vscCell);
        if (cell === undefined) {
            return '';
        }
        // Call internal slice method
        const slices = this._executionSlicer.sliceAllExecutions(cell);
        const program = slices[0].cellSlices.reduce(concat, '');

        // Add a comment at the top of the file explaining what gather does
        const descriptor = '# This file contains the minimal amount of code required to produce the code cell you gathered.\n';
        return descriptor.concat(program);
    }

    public gatherMultipleExecutions(vscCells: IVscCell[]): string {
        const cells = vscCells.map(vscCell => {
            return convertVscToGatherCell(vscCell);
        }).filter(cell => cell !== undefined);

        const slicedExecutions: SlicedExecution[] = [];

        cells.map(
            cell => {
                if (cell) {
                    const slices: SlicedExecution[] = this._executionSlicer.sliceAllExecutions(cell);
                    slicedExecutions.push(slices[0]);
                }
            }
        );

        const program = (merge(slicedExecutions)).cellSlices.reduce(concat, '');

        const descriptor = '# This file contains the minimal amount of code required to produce the code cell you gathered.\n';
        return descriptor.concat(program);
    }

    public get executionSlicer() {
        return this._executionSlicer;
    }

    // Update DataflowAnalyzer's slice configuration. Is called onDidChangeConfiguration
    public updateGatherRules() {
        //     this.dataflowAnalyzer._sliceConfiguration = this.configService.getSettings().datascience.gatherRules;
    }
}

/**
 * Accumulator to concatenate cell slices for a sliced program, preserving cell structures.
 */
function concat(existingText: string, newText: CellSlice) {
    // Include our cell marker so that cell slices are preserved
    return `${existingText}#%%\n${newText.textSliceLines}\n\n`;
}

/**
 * This is called to convert VS Code ICells to Gather ICells for logging.
 * @param cell A cell object conforming to the VS Code cell interface
 */
function convertVscToGatherCell(cell: IVscCell): ICell | undefined {
    // This should always be true since we only want to log code cells. Putting this here so types match for outputs property
    if (cell.data.cell_type === 'code') {
        const result: ICell = {
            // tslint:disable-next-line no-unnecessary-local-variable
            id: cell.id,
            gathered: false,
            dirty: false,
            text: concatMultilineString(cell.data.source),
            executionCount: cell.data.execution_count, // Each cell is run exactly once in the history window
            executionEventId: cell.id, // This is unique for now, so feed it in
            persistentId: cell.id,
            outputs: cell.data.outputs,
            hasError: cell.state === CellState.error,
            is_cell: true
            // tslint:disable-next-line: no-any
        } as any;
        return result;
    }
}

function merge(slicedExecutions: SlicedExecution[]): SlicedExecution {
    const cellSlices: { [cellExecutionEventId: string]: CellSlice } = {};
    const mergedCellSlices = [];
    for (const slicedExecution of slicedExecutions) {
        for (const cellSlice of slicedExecution.cellSlices) {
            const cell = cellSlice.cell;
            if (!cellSlices[cell.executionEventId]) {
                const newCellSlice = new CellSlice(
                    cell,
                    new LocationSet(),
                    cellSlice.executionTime
                );
                cellSlices[cell.executionEventId] = newCellSlice;
                mergedCellSlices.push(newCellSlice);
            }
            const mergedCellSlice = cellSlices[cell.executionEventId];
            mergedCellSlice.slice = mergedCellSlice.slice.union(cellSlice.slice);
        }
    }
    return new SlicedExecution(
        new Date(), // Date doesn't mean anything for the merged slice.
        mergedCellSlices.sort(
            (a, b) => a.cell.executionCount - b.cell.executionCount
        )
    );
}
