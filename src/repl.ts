import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';

// In-app REPL. Evaluates code via indirect eval so that bare names like
// `launch`, `stop`, `engine`, `s`, `scales` resolve through window globals
// (set up in main.ts after audio starts). console.log / warn / error are
// tee'd into the output panel so the controller's existing grid-edit log
// lines show up here too.

type OutKind = 'input' | 'result' | 'error' | 'log';

export class Repl {
  private view: EditorView;
  private outputEl: HTMLElement;

  constructor(editorRoot: HTMLElement, outputEl: HTMLElement, initialDoc = '') {
    this.outputEl = outputEl;

    this.view = new EditorView({
      doc: initialDoc,
      extensions: [
        // Highest-priority keymap ensures Mod-Enter wins over basicSetup's
        // default keymap merging. Mod-Enter = Cmd-Enter on Mac, Ctrl-Enter
        // on Linux/Windows (handled by CodeMirror's Mod alias).
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              preventDefault: true,
              run: v => { this.evaluate(v.state.doc.toString()); return true; },
            },
          ]),
        ),
        basicSetup,
        javascript(),
        EditorView.theme(
          {
            '&': { fontSize: '13px' },
            '&.cm-focused': { outline: 'none' },
            '.cm-scroller': {
              fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
            },
            '.cm-content': { padding: '8px 0' },
          },
          { dark: true },
        ),
      ],
      parent: editorRoot,
    });

    this.installConsoleTee();
  }

  /** Programmatically focus the editor (e.g. on app boot). */
  focus(): void {
    this.view.focus();
  }

  /** Evaluate the current buffer. Wired to a Run button as a backup for
   *  users whose Mod-Enter is captured by the OS or a browser extension. */
  run(): void {
    this.evaluate(this.view.state.doc.toString());
  }

  clearOutput(): void {
    this.outputEl.replaceChildren();
  }

  private installConsoleTee(): void {
    const wrap = (orig: (...a: unknown[]) => void, kind: OutKind) =>
      (...args: unknown[]) => {
        orig.apply(console, args);
        this.append(args.map(formatVal).join(' '), kind);
      };
    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    console.log = wrap(origLog, 'log');
    console.warn = wrap(origWarn, 'log');
    console.error = wrap(origError, 'error');
  }

  private evaluate(code: string): void {
    const trimmed = code.trim();
    if (!trimmed) return;
    this.append(trimmed, 'input');
    try {
      // Indirect eval — runs at global scope so window globals are accessible
      // as bare names. Direct eval would inherit module strict-mode scope.
      const result = (0, eval)(code);
      if (result !== undefined) this.append(formatVal(result), 'result');
    } catch (err) {
      this.append(
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        'error',
      );
    }
  }

  private append(text: string, kind: OutKind): void {
    const line = document.createElement('div');
    line.className = `out-${kind}`;
    line.textContent = kind === 'input' ? `▸ ${text}` : text;
    this.outputEl.appendChild(line);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }
}

function formatVal(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}
