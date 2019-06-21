// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as React from 'react';
// tslint:disable-next-line: import-name match-default-export-name
import Dropdown from 'react-dropdown';
import 'react-dropdown/style.css';

import './comboBox.css';

interface IComboBoxProps {
    values: { value: string; label: string }[];
    currentValue: number;
    // tslint:disable-next-line: no-any
    onChange(selected: any): void;
}

export class ComboBox extends React.Component<IComboBoxProps> {
    constructor(props: IComboBoxProps) {
        super(props);
    }

    public render() {
        const currentValue = this.props.values.length > this.props.currentValue ? this.props.values[this.props.currentValue] : undefined ;
        return (
            <Dropdown
                controlClassName='combobox'
                arrowClassName='combobox-arrow'
                className='combobox-container'
                menuClassName='combobox-menu'
                value={currentValue}
                options={this.props.values}
                onChange={this.props.onChange}/>
        );
    }

}
