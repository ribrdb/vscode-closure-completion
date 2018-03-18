/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for
 * license information.
 * ------------------------------------------------------------------------------------------
 */
'use strict';

import {IPCMessageReader, IPCMessageWriter, createConnection, IConnection, InitializeResult, TextDocumentPositionParams, CompletionItem, CompletionItemKind, TextEdit, Position, Logger} from 'vscode-languageserver';
import {createReadStream, writeFileSync, realpathSync} from 'fs';
import {createInterface} from 'readline';
import * as walk from 'fs-walker';
import {ImportInfo} from './importinfo';
import {PrebakedClosure} from './prebaked';



const wildcardBlacklists = [
  'goog.i18n.CompactNumberFormatSymbols', 'goog.i18n.DateTimePatterns',
  'goog.i18n.DateTimeSymbols', 'goog.i18n.NumberFormatSymbols',
  'goog.labs.i18n.ListFormat'
];

const deprecated = new Set<string>([
  'goog.Delay',
  'goog.Throttle',
  'goog.dom.classes',
  'goog.fs.Error.ErrorCode',
  'goog.fx.Animation.EventType',
  'goog.fx.Animation.State',
  'goog.graphics',
  'goog.i18n.currencyCodeMapTier2',
  'goog.i18n.currencyCodeMap',
  'goog.json.EvalJsonProcessor',
  'goog.net.MockIFrameIo',
  'goog.result',
  'goog.structs.Map',
  'goog.structs.Set',
  'goog.testing.AsyncTestCase',
  'goog.testing.ContinuationTestCase',
  'goog.testing.DeferredTestCase',
  'goog.ui.AttachableMenu',
  'goog.ui.Button.Side',
  'goog.ui.ImagelessButtonRenderer',
  'goog.ui.ImagelessMenuButtonRenderer',
  'goog.ui.Menu.EventType',
  'goog.ui.MenuBase',
  'goog.ui.ServerChart',
  'goog.ui.TabPane',
  'goog.vec.ArrayType',
  'goog.History.EventType',
  'goog.History.Event',
]);

class ImportDB {
  private imports: Map<string, ImportInfo> = new Map();
  private files: Map<string, string[]> = new Map();
  private workspace: string|undefined;
  private completions: CompletionItem[]|undefined;

  constructor(private logger: Logger) {}

  removeFile(path: string) {
    if (this.files.has(path)) {
      this.logger.info(`removing imports from ${path}`);
      // Note: If there's duplicate files and one get's deleted, declarations
      // could disappear one of the others gets updated.
      for (const n of this.files.get(path)) {
        this.imports.delete(n);
      }
      this.files.delete(path);
      this.completions = undefined;
    }
  }

  scanWorkspace(path: string) {
    const logger = this.logger;
    logger.info(`scanning workspace ${path}`);
    this.workspace = path;
    const filter = {
      file(stats: {name: string}): boolean {
        return stats.name.endsWith('.d.ts');
      },
      directory(stats: {name: string}): boolean {
        return !/^(.git|node_modules|.+\.runfiles)$/.test(stats.name);
      }
    };
    const cb = (stats: {fullname: string}) => {
      const path = realpathSync(stats.fullname);
      this.scanFile(path);
    };
    walk(path, filter, cb);
    walk(`${path}/bazel-bin`, filter, cb);
    walk(`${path}/bazel-genfiles`, filter, cb);
  }

  scanFile(path: string) {
    this.removeFile(path);
    this.logger.info(`scanning ${path}`);
    const stream = createReadStream(path);
    const reader = createInterface({input: stream});
    let namespace = '';
    let name = '';
    let skip = '';
    let found: string[] = [];
    reader.on('close', () => {
      if (found.length > 0) {
        this.logger.info(`Found ${found.length} namespaces in ${path}.`);
        this.completions = undefined;
        this.files.set(path, found);
        if (this.workspace) {
          writeFileSync(
              `${this.workspace}/._closure_namespace_cache.json`,
              JSON.stringify(Array.from(this.imports.values())));
        }
      }
    });
    reader.on('line', (line: string) => {
      const match = line.match(/declare module 'goog:(.+)'/);
      if (match) {
        namespace = match[1];
        if (skip) {
          if (namespace.startsWith(skip)) {
            namespace = '';
            return;
          } else {
            skip = '';
          }
        }
        for (const prefix of wildcardBlacklists) {
          if (namespace.startsWith(prefix)) {
            namespace = '';
            return;
          }
        }
        if (deprecated.has(namespace)) {
          skip = `${namespace}.`;
          namespace = '';
          return;
        }
        const dot = namespace.lastIndexOf('.');
        name = dot == -1 ? namespace : namespace.substr(dot + 1);
      } else if (namespace && line.indexOf('export = alias') != -1) {
        if (!this.imports.has(namespace)) {
          this.imports.set(namespace, {
            name: name,
            namespace: namespace,
            module: true,
            sourcepath: path
          });
          found.push(namespace);
        }
      } else if (namespace && line.indexOf('export default alias') != -1) {
        if (!this.imports.has(namespace)) {
          this.imports.set(namespace, {
            name: name,
            namespace: namespace,
            module: false,
            sourcepath: path
          });
          found.push(namespace);
        }
      }
    });
  }

  getCompletions(): CompletionItem[] {
    if (!this.completions) {
      this.logger.info(`Generating ${this.imports.size} completions.`);
      this.completions = [];
      let imports: ImportInfo[] = Array.from(this.imports.values());
      if (!this.imports.has('goog.ui.Component')) {
        imports = imports.concat(PrebakedClosure);
      }
      for (const i of imports) {
        const module = i.module ? '* as ' : '';
        const importText =
            `import ${module}${i.name} from 'goog:${i.namespace}';\n`;
        const addImport: TextEdit =
            TextEdit.insert(Position.create(0, 0), importText);
        const item: CompletionItem = {
          label: i.name,
          detail: `Auto import ${i.namespace}`,
          kind: i.module ? CompletionItemKind.Module : CompletionItemKind.Class,
          additionalTextEdits: [addImport],
          commitCharacters: ['.'],
        };
        this.completions.push(item);
      }
    }
    return this.completions;
  }
}

// Create a connection for the server. The connection uses Node's IPC as a
// transport
let connection: IConnection = createConnection(
    new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
// let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
// documents.listen(connection);

const db = new ImportDB(connection.console);

// After the server has started the client sends an initialize request. The
// server receives in the passed params the rootPath of the workspace plus the
// client capabilities.
connection.onInitialize((_params): InitializeResult => {
  if (_params.rootPath) {
    db.scanWorkspace(_params.rootPath);
  }
  return {
    capabilities: {
      // Tell the client that the server works in FULL text document sync mode
      textDocumentSync: 0,
      // Tell the client that the server support code complete
      completionProvider: {resolveProvider: false}
    }
  }
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
// documents.onDidChangeContent(
//     (change) => {

//     });

// The settings interface describe the server relevant settings part
// interface Settings {
//   lspSample: ExampleSettings;
// }

// These are the example settings we defined in the client's package.json
// file
// interface ExampleSettings {
//   maxNumberOfProblems: number;
// }

// // hold the maxNumberOfProblems setting
// let maxNumberOfProblems: number;
// // The settings have changed. Is send on server activation
// // as well.
// connection.onDidChangeConfiguration(
//     (change) => {
//         // let settings = <Settings>change.settings;
//         // maxNumberOfProblems = settings.lspSample.maxNumberOfProblems ||
//         100;
//         // // Revalidate any open text documents
//         // documents.all().forEach(validateTextDocument);
//     });

connection.onDidChangeWatchedFiles((_change) => {
  // Monitored files have change in VSCode
  connection.console.log(
      `We received a file change event: ${JSON.stringify(_change)}`);
  const processed: Set<string> = new Set();
  for (const change of _change.changes) {
    if (change.uri.startsWith('file://')) {
      const path = realpathSync(change.uri.substr(7));
      if (!processed.has(path)) {
        if (change.type == 3 /* Deleted */) {
          db.removeFile(path);
        } else {
          db.scanFile(path);
        }
        processed.add(path);
      }
    }
  }
});


// This handler provides the initial list of the completion items.
connection.onCompletion(
    (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
      // The pass parameter contains the position of the text document in
      // which code complete got requested. For the example we ignore this
      // info and always provide the same completion items.
      return db.getCompletions();
    });



/*
connection.onDidOpenTextDocument((params) => {
        // A text document got opened in VSCode.
        // params.uri uniquely identifies the document. For documents store on
disk this is a file URI.
        // params.text the initial full content of the document.
        connection.console.log(`${params.textDocument.uri} opened.`);
});
connection.onDidChangeTextDocument((params) => {
        // The content of a text document did change in VSCode.
        // params.uri uniquely identifies the document.
        // params.contentChanges describe the content changes to the document.
        connection.console.log(`${params.textDocument.uri} changed:
${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
        // A text document got closed in VSCode.
        // params.uri uniquely identifies the document.
        connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Listen on the connection
connection.listen();
