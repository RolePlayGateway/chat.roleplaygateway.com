/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2018, 2019 New Vector Ltd
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>
Copyright 2020 The Matrix.org Foundation C.I.C.

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

import olmWasmPath from 'olm/olm.wasm';

import React from 'react';
// add React and ReactPerf to the global namespace, to make them easier to
// access via the console
global.React = React;

import ReactDOM from 'react-dom';
import * as sdk from 'matrix-react-sdk';
import PlatformPeg from 'matrix-react-sdk/src/PlatformPeg';
import * as VectorConferenceHandler from 'matrix-react-sdk/src/VectorConferenceHandler';
import * as languageHandler from 'matrix-react-sdk/src/languageHandler';
import {_t, _td, newTranslatableError} from 'matrix-react-sdk/src/languageHandler';
import AutoDiscoveryUtils from 'matrix-react-sdk/src/utils/AutoDiscoveryUtils';
import {AutoDiscovery} from "matrix-js-sdk/src/autodiscovery";
import * as Lifecycle from "matrix-react-sdk/src/Lifecycle";

import url from 'url';

import {parseQs, parseQsFromFragment} from './url_utils';

import ElectronPlatform from './platform/ElectronPlatform';
import WebPlatform from './platform/WebPlatform';

import {MatrixClientPeg} from 'matrix-react-sdk/src/MatrixClientPeg';
import SettingsStore from "matrix-react-sdk/src/settings/SettingsStore";
import SdkConfig from "matrix-react-sdk/src/SdkConfig";
import {setTheme} from "matrix-react-sdk/src/theme";

import Olm from 'olm';

import CallHandler from 'matrix-react-sdk/src/CallHandler';

let lastLocationHashSet = null;

function checkBrowserFeatures() {
    if (!window.Modernizr) {
        console.error("Cannot check features - Modernizr global is missing.");
        return false;
    }

    // custom checks atop Modernizr because it doesn't have ES2018/ES2019 checks in it for some features we depend on,
    // Modernizr requires rules to be lowercase with no punctuation:
    // ES2018: http://www.ecma-international.org/ecma-262/9.0/#sec-promise.prototype.finally
    window.Modernizr.addTest("promiseprototypefinally", () =>
        window.Promise && window.Promise.prototype && typeof window.Promise.prototype.finally === "function");
    // ES2019: http://www.ecma-international.org/ecma-262/10.0/#sec-object.fromentries
    window.Modernizr.addTest("objectfromentries", () =>
        window.Object && typeof window.Object.fromEntries === "function");

    const featureList = Object.keys(window.Modernizr);

    let featureComplete = true;
    for (let i = 0; i < featureList.length; i++) {
        if (window.Modernizr[featureList[i]] === undefined) {
            console.error(
                "Looked for feature '%s' but Modernizr has no results for this. " +
                "Has it been configured correctly?", featureList[i],
            );
            return false;
        }
        if (window.Modernizr[featureList[i]] === false) {
            console.error("Browser missing feature: '%s'", featureList[i]);
            // toggle flag rather than return early so we log all missing features rather than just the first.
            featureComplete = false;
        }
    }
    return featureComplete;
}

// Parse the given window.location and return parameters that can be used when calling
// MatrixChat.showScreen(screen, params)
function getScreenFromLocation(location) {
    const fragparts = parseQsFromFragment(location);
    return {
        screen: fragparts.location.substring(1),
        params: fragparts.params,
    };
}

// Here, we do some crude URL analysis to allow
// deep-linking.
function routeUrl(location) {
    if (!window.matrixChat) return;

    console.log("Routing URL ", location.href);
    const s = getScreenFromLocation(location);
    window.matrixChat.showScreen(s.screen, s.params);
}

function onHashChange(ev) {
    if (decodeURIComponent(window.location.hash) === lastLocationHashSet) {
        // we just set this: no need to route it!
        return;
    }
    routeUrl(window.location);
}

// This will be called whenever the SDK changes screens,
// so a web page can update the URL bar appropriately.
function onNewScreen(screen) {
    console.log("newscreen "+screen);
    const hash = '#/' + screen;
    lastLocationHashSet = hash;
    window.location.hash = hash;
}

// We use this to work out what URL the SDK should
// pass through when registering to allow the user to
// click back to the client having registered.
// It's up to us to recognise if we're loaded with
// this URL and tell MatrixClient to resume registration.
//
// If we're in electron, we should never pass through a file:// URL otherwise
// the identity server will try to 302 the browser to it, which breaks horribly.
// so in that instance, hardcode to use riot.im/app for now instead.
function makeRegistrationUrl(params) {
    let url;
    if (window.location.protocol === "vector:") {
        url = 'https://riot.im/app/#/register';
    } else {
        url = (
            window.location.protocol + '//' +
            window.location.host +
            window.location.pathname +
            '#/register'
        );
    }

    const keys = Object.keys(params);
    for (let i = 0; i < keys.length; ++i) {
        if (i === 0) {
            url += '?';
        } else {
            url += '&';
        }
        const k = keys[i];
        url += k + '=' + encodeURIComponent(params[k]);
    }
    return url;
}

function onTokenLoginCompleted() {
    // if we did a token login, we're now left with the token, hs and is
    // url as query params in the url; a little nasty but let's redirect to
    // clear them.
    const parsedUrl = url.parse(window.location.href);
    parsedUrl.search = "";
    const formatted = url.format(parsedUrl);
    console.log("Redirecting to " + formatted + " to drop loginToken " +
        "from queryparams");
    window.location.href = formatted;
}

export async function loadApp() {
    // XXX: the way we pass the path to the worker script from webpack via html in body's dataset is a hack
    // but alternatives seem to require changing the interface to passing Workers to js-sdk
    const vectorIndexeddbWorkerScript = document.body.dataset.vectorIndexeddbWorkerScript;
    if (!vectorIndexeddbWorkerScript) {
        // If this is missing, something has probably gone wrong with
        // the bundling. The js-sdk will just fall back to accessing
        // indexeddb directly with no worker script, but we want to
        // make sure the indexeddb script is present, so fail hard.
        throw new Error("Missing indexeddb worker script!");
    }
    MatrixClientPeg.setIndexedDbWorkerScript(vectorIndexeddbWorkerScript);
    CallHandler.setConferenceHandler(VectorConferenceHandler);

    window.addEventListener('hashchange', onHashChange);

    await loadOlm();

    // set the platform for react sdk
    if (window.ipcRenderer) {
        console.log("Using Electron platform");
        const plaf = new ElectronPlatform();
        PlatformPeg.set(plaf);
    } else {
        console.log("Using Web platform");
        PlatformPeg.set(new WebPlatform());
    }

    const platform = PlatformPeg.get();

    let configJson;
    let configError;
    let configSyntaxError = false;
    try {
        configJson = await platform.getConfig();
    } catch (e) {
        configError = e;

        if (e && e.err && e.err instanceof SyntaxError) {
            console.error("SyntaxError loading config:", e);
            configSyntaxError = true;
            configJson = {}; // to prevent errors between here and loading CSS for the error box
        }
    }

    // XXX: We call this twice, once here and once in MatrixChat as a prop. We call it here to ensure
    // granular settings are loaded correctly and to avoid duplicating the override logic for the theme.
    SdkConfig.put(configJson);

    // Load language after loading config.json so that settingsDefaults.language can be applied
    await loadLanguage();

    const fragparts = parseQsFromFragment(window.location);
    const params = parseQs(window.location);

    // don't try to redirect to the native apps if we're
    // verifying a 3pid (but after we've loaded the config)
    // or if the user is following a deep link
    // (https://github.com/vector-im/riot-web/issues/7378)
    const preventRedirect = fragparts.params.client_secret || fragparts.location.length > 0;

    if (!preventRedirect) {
        const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const isAndroid = /Android/.test(navigator.userAgent);
        if (isIos || isAndroid) {
            if (document.cookie.indexOf("riot_mobile_redirect_to_guide=false") === -1) {
                window.location = "mobile_guide/";
                return;
            }
        }
    }

    // as quickly as we possibly can, set a default theme...
    await setTheme();

    // Now that we've loaded the theme (CSS), display the config syntax error if needed.
    if (configSyntaxError) {
        const errorMessage = (
            <div>
                <p>
                    {_t(
                        "Your Riot configuration contains invalid JSON. Please correct the problem " +
                        "and reload the page.",
                    )}
                </p>
                <p>
                    {_t(
                        "The message from the parser is: %(message)s",
                        {message: configError.err.message || _t("Invalid JSON")},
                    )}
                </p>
            </div>
        );

        const GenericErrorPage = sdk.getComponent("structures.GenericErrorPage");
        window.matrixChat = ReactDOM.render(
            <GenericErrorPage message={errorMessage} title={_t("Your Riot is misconfigured")} />,
            document.getElementById('matrixchat'),
        );
        return;
    }

    const validBrowser = checkBrowserFeatures();

    const acceptInvalidBrowser = window.localStorage && window.localStorage.getItem('mx_accepts_unsupported_browser');

    const urlWithoutQuery = window.location.protocol + '//' + window.location.host + window.location.pathname;
    console.log("Vector starting at " + urlWithoutQuery);
    if (configError) {
        window.matrixChat = ReactDOM.render(<div className="error">
            Unable to load config file: please refresh the page to try again.
        </div>, document.getElementById('matrixchat'));
    } else if (validBrowser || acceptInvalidBrowser) {
        platform.startUpdater();

        // Don't bother loading the app until the config is verified
        verifyServerConfig().then((newConfig) => {
            const MatrixChat = sdk.getComponent('structures.MatrixChat');
            window.matrixChat = ReactDOM.render(
                <MatrixChat
                    onNewScreen={onNewScreen}
                    makeRegistrationUrl={makeRegistrationUrl}
                    ConferenceHandler={VectorConferenceHandler}
                    config={newConfig}
                    realQueryParams={params}
                    startingFragmentQueryParams={fragparts.params}
                    enableGuest={!configJson.disable_guests}
                    onTokenLoginCompleted={onTokenLoginCompleted}
                    initialScreenAfterLogin={getScreenFromLocation(window.location)}
                    defaultDeviceDisplayName={platform.getDefaultDeviceDisplayName()}
                />,
                document.getElementById('matrixchat'),
            );
        }).catch(err => {
            console.error(err);

            let errorMessage = err.translatedMessage
                || _t("Unexpected error preparing the app. See console for details.");
            errorMessage = <span>{errorMessage}</span>;

            // Like the compatibility page, AWOOOOOGA at the user
            const GenericErrorPage = sdk.getComponent("structures.GenericErrorPage");
            window.matrixChat = ReactDOM.render(
                <GenericErrorPage message={errorMessage} title={_t("Your Riot is misconfigured")} />,
                document.getElementById('matrixchat'),
            );
        });
    } else {
        console.error("Browser is missing required features.");
        // take to a different landing page to AWOOOOOGA at the user
        const CompatibilityPage = sdk.getComponent("structures.CompatibilityPage");
        window.matrixChat = ReactDOM.render(
            <CompatibilityPage onAccept={function() {
                if (window.localStorage) window.localStorage.setItem('mx_accepts_unsupported_browser', true);
                console.log("User accepts the compatibility risks.");
                loadApp();
            }} />,
            document.getElementById('matrixchat'),
        );
    }
}

function loadOlm() {
    /* Load Olm. We try the WebAssembly version first, and then the legacy,
     * asm.js version if that fails. For this reason we need to wait for this
     * to finish before continuing to load the rest of the app. In future
     * we could somehow pass a promise down to react-sdk and have it wait on
     * that so olm can be loading in parallel with the rest of the app.
     *
     * We also need to tell the Olm js to look for its wasm file at the same
     * level as index.html. It really should be in the same place as the js,
     * ie. in the bundle directory, but as far as I can tell this is
     * completely impossible with webpack. We do, however, use a hashed
     * filename to avoid caching issues.
     */
    return Olm.init({
        locateFile: () => olmWasmPath,
    }).then(() => {
        console.log("Using WebAssembly Olm");
    }).catch((e) => {
        console.log("Failed to load Olm: trying legacy version", e);
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'olm_legacy.js'; // XXX: This should be cache-busted too
            s.onload = resolve;
            s.onerror = reject;
            document.body.appendChild(s);
        }).then(() => {
            // Init window.Olm, ie. the one just loaded by the script tag,
            // not 'Olm' which is still the failed wasm version.
            return window.Olm.init();
        }).then(() => {
            console.log("Using legacy Olm");
        }).catch((e) => {
            console.log("Both WebAssembly and asm.js Olm failed!", e);
        });
    });
}

async function loadLanguage() {
    const prefLang = SettingsStore.getValue("language", null, /*excludeDefault=*/true);
    let langs = [];

    if (!prefLang) {
        languageHandler.getLanguagesFromBrowser().forEach((l) => {
            langs.push(...languageHandler.getNormalizedLanguageKeys(l));
        });
    } else {
        langs = [prefLang];
    }
    try {
        await languageHandler.setLanguage(langs);
        document.documentElement.setAttribute("lang", languageHandler.getCurrentLanguage());
    } catch (e) {
        console.error("Unable to set language", e);
    }
}

async function verifyServerConfig() {
    let validatedConfig;
    try {
        console.log("Verifying homeserver configuration");

        // Note: the query string may include is_url and hs_url - we only respect these in the
        // context of email validation. Because we don't respect them otherwise, we do not need
        // to parse or consider them here.

        // Note: Although we throw all 3 possible configuration options through a .well-known-style
        // verification, we do not care if the servers are online at this point. We do moderately
        // care if they are syntactically correct though, so we shove them through the .well-known
        // validators for that purpose.

        const config = SdkConfig.get();
        let wkConfig = config['default_server_config']; // overwritten later under some conditions
        const serverName = config['default_server_name'];
        const hsUrl = config['default_hs_url'];
        const isUrl = config['default_is_url'];

        const incompatibleOptions = [wkConfig, serverName, hsUrl].filter(i => !!i);
        if (incompatibleOptions.length > 1) {
            // noinspection ExceptionCaughtLocallyJS
            throw newTranslatableError(_td(
                "Invalid configuration: can only specify one of default_server_config, default_server_name, " +
                "or default_hs_url.",
            ));
        }
        if (incompatibleOptions.length < 1) {
            // noinspection ExceptionCaughtLocallyJS
            throw newTranslatableError(_td("Invalid configuration: no default server specified."));
        }

        if (hsUrl) {
            console.log("Config uses a default_hs_url - constructing a default_server_config using this information");
            console.warn(
                "DEPRECATED CONFIG OPTION: In the future, default_hs_url will not be accepted. Please use " +
                "default_server_config instead.",
            );

            wkConfig = {
                "m.homeserver": {
                    "base_url": hsUrl,
                },
            };
            if (isUrl) {
                wkConfig["m.identity_server"] = {
                    "base_url": isUrl,
                };
            }
        }

        let discoveryResult = null;
        if (wkConfig) {
            console.log("Config uses a default_server_config - validating object");
            discoveryResult = await AutoDiscovery.fromDiscoveryConfig(wkConfig);
        }

        if (serverName) {
            console.log("Config uses a default_server_name - doing .well-known lookup");
            console.warn(
                "DEPRECATED CONFIG OPTION: In the future, default_server_name will not be accepted. Please " +
                "use default_server_config instead.",
            );
            discoveryResult = await AutoDiscovery.findClientConfig(serverName);
        }

        validatedConfig = AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult, true);
    } catch (e) {
        const {hsUrl, isUrl, userId} = Lifecycle.getLocalStorageSessionVars();
        if (hsUrl && userId) {
            console.error(e);
            console.warn("A session was found - suppressing config error and using the session's homeserver");

            console.log("Using pre-existing hsUrl and isUrl: ", {hsUrl, isUrl});
            validatedConfig = await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(hsUrl, isUrl, true);
        } else {
            // the user is not logged in, so scream
            throw e;
        }
    }


    validatedConfig.isDefault = true;

    // Just in case we ever have to debug this
    console.log("Using homeserver config:", validatedConfig);

    // Add the newly built config to the actual config for use by the app
    console.log("Updating SdkConfig with validated discovery information");
    SdkConfig.add({"validated_server_config": validatedConfig});

    return SdkConfig.get();
}
