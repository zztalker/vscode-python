import { injectable } from 'inversify';
import { noop } from '../../common/utils/misc';
import { concatMultilineString } from '../common';
import { CellState, ICell as IVscCell, IGatherExecution, INotebookExecutionLogger } from '../types';
import { DataflowAnalyzer } from './analysis/slice/data-flow';
import { ExecutionLogSlicer } from './analysis/slice/log-slicer';
import { ICell, LabCell } from './model/cell';
import { CellSlice } from './model/cellslice';

const DEFAULT_SLICECONFIG_RULES = [
    {
        objectName: 'df',
        functionName: 'head',
        doesNotModify: ['OBJECT']
    }, {
        objectName: 'df',
        functionName: 'tail',
        doesNotModify: ['OBJECT']
    }, {
        objectName: 'df',
        functionName: 'describe',
        doesNotModify: ['OBJECT']
    }, {
        functionName: 'print',
        doesNotModify: ['ARGUMENTS']
    }, {
        functionName: 'KMeans',
        doesNotModify: ['ARGUMENTS']
    }, {
        functionName: 'scatter',
        doesNotModify: ['ARGUMENTS']
    }, {
        functionName: 'fit',
        doesNotModify: ['ARGUMENTS']
    }, {
        functionName: 'sum',
        doesNotModify: ['ARGUMENTS']
    }, {
        functionName: 'len',
        doesNotModify: ['ARGUMENTS']
    }];

/**
 * An adapter class to wrap the code gathering functionality from [microsoft/gather](https://github.com/microsoft/gather).
 */
@injectable()
export class GatherExecution implements IGatherExecution, INotebookExecutionLogger {
    private _executionLogger: ExecutionLogSlicer;

    constructor(
    ) {
        const dataflowAnalyzer = new DataflowAnalyzer(DEFAULT_SLICECONFIG_RULES); // Pass in a sliceConfiguration object, or not
        this._executionLogger = new ExecutionLogSlicer(dataflowAnalyzer);
    }

    public async preExecute(_vscCell: IVscCell, _silent: boolean): Promise<void> {
        // This function is just implemented here for compliance with the INotebookExecutionLogger interface
        noop();
    }

    public async postExecute(vscCell: IVscCell, _silent: boolean): Promise<void> {
        // Don't try logging if vscCell.data.source is an empty string because parser barfs
        if (vscCell.data.source !== '') {
            // Convert IVscCell to IGatherCell
            const cell = convertVscToGatherCell(vscCell) as LabCell;

            // Call internal logging method
            this._executionLogger.logExecution(cell);
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
        const slices = this._executionLogger.sliceAllExecutions(cell);
        return slices[0].cellSlices.reduce(concat, '');
    }
}

/**
 * Accumulator to concatenate cell slices for a sliced program, preserving cell structures.
 */
function concatWithoutCellMarkers(existingText: string, newText: CellSlice) {
    return `${existingText}\n${newText.textSliceLines}\n\n`;
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
        };
        return result;
    }
}
