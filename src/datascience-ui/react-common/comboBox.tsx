// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as React from 'react';
import Select from 'react-select/lib/Select';
import { ValueType } from 'react-select/lib/types';

interface IComboBoxProps {
    values: { value: string; label: string }[];
    currentValue: number;
    onChange(selected: ValueType<{value: string; label: string}>): void;
}

export class ComboBox extends React.Component<IComboBoxProps> {
    constructor(props: IComboBoxProps) {
        super(props);
    }

    public render() {
        const currentValue = this.props.values.length > this.props.currentValue ? this.props.values[this.props.currentValue] : undefined ;
        return (
            <Select value={currentValue} options={this.props.values} onChange={this.props.onChange}/>
        );
    }

}
