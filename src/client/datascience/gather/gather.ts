import { nbformat } from '@jupyterlab/coreutils/lib/nbformat';
import { DataflowAnalyzer } from './analysis/slice/data-flow';
import { ExecutionLogSlicer } from './analysis/slice/log-slicer';
import { ICell, LabCell } from './model/cell';
import { CellSlice } from './model/cellslice';

export interface IGatherExecution {
    logExecution(vscCell: IVscCell): void;
    gatherCode(vscCell: IVscCell): string;
}

export class GatherExecution {
    private _executionLogger: ExecutionLogSlicer;

    constructor() {
        const dataflowAnalyzer = new DataflowAnalyzer(); // Pass in a sliceConfiguration object, or not
        this._executionLogger = new ExecutionLogSlicer(dataflowAnalyzer);
    }

    public logExecution(vscCell: IVscCell): void {
        // Convert IVscCell to ICell
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

enum CellState {
    editing = -1,
    init = 0,
    executing = 1,
    finished = 2,
    error = 3
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

function concatMultilineString(str: nbformat.MultilineString): string {
    if (Array.isArray(str)) {
        let result = '';
        for (let i = 0; i < str.length; i += 1) {
            const s = str[i];
            if (i < str.length - 1 && !s.endsWith('\n')) {
                result = result.concat(`${s}\n`);
            } else {
                result = result.concat(s);
            }
        }
        return result.trim();
    }
    return str.toString().trim();
}

interface IMessageCell extends nbformat.IBaseCell {
    cell_type: 'messages';
    messages: string[];
}

/**
 * Intended to map from ICell in vscode-python repo to ICell in gather repo.
 */
interface IVscCell {
    id: string;
    file: string;
    line: number;
    state: CellState;
    type: 'preview' | 'execute';
    data: nbformat.ICodeCell | nbformat.IRawCell | nbformat.IMarkdownCell | IMessageCell;
}
