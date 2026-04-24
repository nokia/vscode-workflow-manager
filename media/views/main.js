//@ts-check

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
(function () {
    const vscode = acquireVsCodeApi();

    const oldState = vscode.getState() || { colors: [] };

    /** @type {Array<{ value: string }>} */
    let colors = oldState.colors;
    try { // actions actions

        document.getElementById('contextdata').style.display = 'none'; 

        document.querySelector('.color-select').addEventListener('change', () => {
            let demo = document.querySelector(".color-select");
            let snippet = demo.options[demo.selectedIndex].getAttribute('snippet');
            if (["nsp.python", "std.javascript"].includes(demo.options[demo.selectedIndex].getAttribute('value'))) {
                document.getElementById('contextdata').style.display = 'block';
            } else {
                document.getElementById('contextdata').style.display = 'none';
            }
            document.querySelector(".color-ta").value = snippet;
            //addColor();
        });

        document.getElementById('tryAction').addEventListener('click', () => {
            let demo = document.querySelector(".color-select");
            let action = demo.options[demo.selectedIndex].getAttribute('value');
            let payload = document.getElementById("actioninputs").value;
            let context = "";
            if (["nsp.python", "std.javascript"].includes(demo.options[demo.selectedIndex].getAttribute('value'))) {
                context = document.getElementById("contextdata").value;
            }
            vscode.postMessage({ type: 'action', action: action, payload: payload, context: context });

        });
        document.getElementById('addAction').addEventListener('click', () => {
            let demo = document.querySelector(".color-select");
            let action = demo.options[demo.selectedIndex].getAttribute('value');
            let payload = document.getElementById("actioninputs").value;
            vscode.postMessage({ type: 'addtoworkflow', action: action, payload: payload });

        });

    } catch (error) {
        console.log("No color select element found.");
    }
    try { // WFM filters (YAQL / Python / JavaScript)
        const filterTypeSelect = document.getElementById('filterType');
        const codeInput = document.getElementById('yaqlexpression');
        const actionsByMode = {
            yaql: 'nsp.yaql_eval',
            python: 'nsp.python',
            javascript: 'std.javascript'
        };
        const placeholdersByMode = {
            yaql: 'Enter YAQL expression',
            python: 'Enter Python script',
            javascript: 'Enter JavaScript'
        };
        function syncFilterPlaceholder() {
            const mode = filterTypeSelect.value;
            codeInput.placeholder = placeholdersByMode[mode] || '';
        }
        filterTypeSelect.addEventListener('change', syncFilterPlaceholder);
        syncFilterPlaceholder();
        document.getElementById('sendYaql').addEventListener('click', () => {
            const mode = filterTypeSelect.value;
            vscode.postMessage({
                type: 'filter',
                action: actionsByMode[mode],
                code: codeInput.value,
                context: document.getElementById('contextdatayq').value
            });
        });
    } catch (error) {
        console.log("No WFM filters UI found.");
    }


}());


