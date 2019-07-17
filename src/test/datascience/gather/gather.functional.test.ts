// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { UUID } from '@phosphor/coreutils';
import * as assert from 'assert';
import { generateCodeCell } from '../../../client/datascience/cellFactory';
import { GatherExecution } from '../../../client/datascience/gather/gather';
import { ICell as IVscCell } from '../../../client/datascience/types';

suite('DataScience code gathering tests', () => {
    const cells: IVscCell[] = [];
    const gatherExecution = new GatherExecution();

    setup(() => {
        const code = [
            [
                'from bokeh.plotting import show, figure, output_notebook\n',
                'output_notebook()'
            ],
            [
                'x = [1,2,3,4,5]\n',
                'y = [21,9,15,17,4]\n',
                'print(\'This is some irrelevant code\')'
            ],
            [
                'p=figure(title="demo",x_axis_label="x",y_axis_label="y")\n'
            ],
            [
                'var: 10\n' // Syntactically inaccurate code to check that Gather handles code with errors
            ],
            [
                'p.line(x,y,line_width=2)\n'
            ],
            [
                'show(p)'
            ]
        ];

        code.forEach((string) => {
            cells.push(generateCodeCell(string, 'Untitled-1', 0, UUID.uuid4(), true));
        });
    });

    test('Log a cell execution', async () => {
        let count = 0;
        cells.forEach(async (cell) => {
            await gatherExecution.postExecute(cell, false);
            count += 1;
            // Expect length to change
            assert.equal(gatherExecution.executionSlicer._executionLog.length, count);
        })
    });

    test('Gather program slices for a cell', () => {
        const cell: IVscCell = cells[cells.length - 1];
        const program = gatherExecution.gatherCode(cell);
        // Expect program to equal wtv
        const expectedGather = '#%%\n from bokeh.plotting import show, figure, output_notebook\noutput_notebook()\n\n#%%x = [1,2,3,4,5]\ny = [21,9,15,17,4]\n\n#%%\np=figure(title="demo",x_axis_label="x",y_axis_label="y")\np.line(x,y,line_width=2)\n\n#%%\nshow(p)\n\n';
        assert.equal(program.trim(), expectedGather.trim());
    });

});
