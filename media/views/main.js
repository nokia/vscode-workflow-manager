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
    try { // YAQL actions
        document.getElementById('sendYaql').addEventListener('click', () => {
            let expression = document.getElementById("yaqlexpression").value;
            let context = document.getElementById("contextdatayq").value;
            vscode.postMessage({ type: 'yaql', expression: expression, context: context });

        });
    } catch (error) {
        console.log("No YAQL button found.");
    }


}());


