import { injectable } from 'inversify';
import { noop } from '../../common/utils/misc';
import { concatMultilineString } from '../common';
import { CellState, ICell as IVscCell, IGatherExecution, INotebookExecutionLogger } from '../types';
import { DataflowAnalyzer } from './analysis/slice/data-flow';
import { ExecutionLogSlicer } from './analysis/slice/log-slicer';
import { ICell, LabCell } from './model/cell';
import { CellSlice } from './model/cellslice';

@injectable()
export class GatherExecution implements IGatherExecution, INotebookExecutionLogger {
    private _executionLogger: ExecutionLogSlicer;

    constructor(
    ) {
        const dataflowAnalyzer = new DataflowAnalyzer(); // Pass in a sliceConfiguration object, or not
        this._executionLogger = new ExecutionLogSlicer(dataflowAnalyzer);
    }

    public async preExecute(_vscCell: IVscCell, _silent: boolean): Promise<void> {
        // This function is just implemented here for compliance with the INotebookExecutionLogger interface
        noop();
    }

    public async postExecute(vscCell: IVscCell, _silent: boolean): Promise<void> {
        // Convert IVscCell to IGatherCell
        const cell = (convertVscToGatherCell(vscCell) as LabCell).deepCopy();

        // Call internal logging method
        this._executionLogger.logExecution(cell);
    }

    public gatherCode(vscCell: IVscCell): string {
        // sliceAllExecutions does a lookup based on executionEventId
        const cell = convertVscToGatherCell(vscCell);
        if (cell === undefined) {
            return '';
        }

        // Call internal slice method
        const slices = this._executionLogger.sliceAllExecutions(cell);
        const mergedSlice = slices[0].merge(...slices.slice(1));
        return mergedSlice.cellSlices.reduce(concat, '');
    }
}

function concat(existingText: string, newText: CellSlice) {
    return `${existingText}${newText}\n`;
}

/**
 * This is called to convert VS Code ICells to Gather ICells for logging.
 * @param cell A cell object conforming to the VS Code cell interface
 */
function convertVscToGatherCell(cell: IVscCell): ICell | undefined {
    // This should always be true since we only want to log code cells. Putting this here so types match for outputs property
    if (cell.data.cell_type === 'code') {
        return {
            id: cell.id,
            gathered: false,
            dirty: false,
            text: concatMultilineString(cell.data.source),
            executionCount: 1, // Each cell is run exactly once in the history window
            executionEventId: cell.id, // This is unique for now, so feed it in
            persistentId: cell.id,
            outputs: cell.data.outputs,
            hasError: cell.state === CellState.error,
            is_cell: true
        };
    }
}
