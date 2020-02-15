// @flow

/*
Copyright 2016 Aviral Dasgupta
Copyright 2016 OpenMarket Ltd
Copyright 2018 New Vector Ltd
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import BasePlatform from 'matrix-react-sdk/src/BasePlatform';
import { _t } from 'matrix-react-sdk/src/languageHandler';
import dis from 'matrix-react-sdk/src/dispatcher';
import {getVectorConfig} from "../getconfig";

import Favico from 'favico.js';

export const updateCheckStatusEnum = {
    CHECKING: 'CHECKING',
    ERROR: 'ERROR',
    NOTAVAILABLE: 'NOTAVAILABLE',
    DOWNLOADING: 'DOWNLOADING',
    READY: 'READY',
};

/**
 * Vector-specific extensions to the BasePlatform template
 */
export default class VectorBasePlatform extends BasePlatform {
    constructor() {
        super();

        this.showUpdateCheck = false;
        this.startUpdateCheck = this.startUpdateCheck.bind(this);
        this.stopUpdateCheck = this.stopUpdateCheck.bind(this);
    }

    async getConfig(): Promise<{}> {
        return getVectorConfig();
    }

    getHumanReadableName(): string {
        return 'Vector Base Platform'; // no translation required: only used for analytics
    }

    /**
     * Delay creating the `Favico` instance until first use (on the first notification) as
     * it uses canvas, which can trigger a permission prompt in Firefox's resist
     * fingerprinting mode.
     * See https://github.com/vector-im/riot-web/issues/9605.
     */
    get favicon() {
        if (this._favicon) {
            return this._favicon;
        }
        // The 'animations' are really low framerate and look terrible.
        // Also it re-starts the animation every time you set the badge,
        // and we set the state each time, even if the value hasn't changed,
        // so we'd need to fix that if enabling the animation.
        this._favicon = new Favico({ animation: 'none' });
        return this._favicon;
    }

    _updateFavicon() {
        try {
            // This needs to be in in a try block as it will throw
            // if there are more than 100 badge count changes in
            // its internal queue
            let bgColor = "#d00";
            let notif = this.notificationCount;

            if (this.errorDidOccur) {
                notif = notif || "×";
                bgColor = "#f00";
            }

            const doUpdate = () => {
                this.favicon.badge(notif, {
                    bgColor: bgColor,
                });
            };

            doUpdate();

            // HACK: Workaround for Chrome 78+ and dependency incompatibility.
            // The library we use doesn't appear to work in Chrome 78, likely due to their
            // changes surrounding tab behaviour. Tabs went through a bit of a redesign and
            // restructuring in Chrome 78, so it's not terribly surprising that the library
            // doesn't work correctly. The library we use hasn't been updated in years and
            // does not look easy to fix/fork ourselves - we might as well write our own that
            // doesn't include animation/webcam/etc support. However, that's a bit difficult
            // so for now we'll just trigger the update twice.
            //
            // Note that trying to reproduce the problem in isolation doesn't seem to work:
            // see https://gist.github.com/turt2live/5ab87919918adbfd7cfb8f1ad10f2409 for
            // an example (you'll need your own web server to host that).
            if (window.chrome) {
                doUpdate();
            }
        } catch (e) {
            console.warn(`Failed to set badge count: ${e.message}`);
        }
    }

    setNotificationCount(count: number) {
        if (this.notificationCount === count) return;
        super.setNotificationCount(count);
        this._updateFavicon();
    }

    setErrorStatus(errorDidOccur: boolean) {
        if (this.errorDidOccur === errorDidOccur) return;
        super.setErrorStatus(errorDidOccur);
        this._updateFavicon();
    }

    /**
     * Begin update polling, if applicable
     */
    startUpdater() {
    }

    /**
     * Whether we can call checkForUpdate on this platform build
     */
    async canSelfUpdate(): boolean {
        return false;
    }

    startUpdateCheck() {
        this.showUpdateCheck = true;
        dis.dispatch({
            action: 'check_updates',
            value: { status: updateCheckStatusEnum.CHECKING },
        });
    }

    stopUpdateCheck() {
        this.showUpdateCheck = false;
        dis.dispatch({
            action: 'check_updates',
            value: false,
        });
    }

    getUpdateCheckStatusEnum() {
        return updateCheckStatusEnum;
    }

    /**
     * Update the currently running app to the latest available
     * version and replace this instance of the app with the
     * new version.
     */
    installUpdate() {
    }

    /**
     * Get a sensible default display name for the
     * device Vector is running on
     */
    getDefaultDeviceDisplayName(): string {
        return _t("Unknown device");
    }
}
