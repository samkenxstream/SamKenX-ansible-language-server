import IntervalTree from '@flatten-js/interval-tree';
import * as child_process from 'child_process';
import { ExecException } from 'node:child_process';
import { URL } from 'url';
import { promisify } from 'util';
import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  TextDocumentContentChangeEvent,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceFolderContext } from './workspaceManager';
const exec = promisify(child_process.exec);

export class AnsibleLint {
  private connection: Connection;
  private context: WorkspaceFolderContext;
  private validationCache: Map<string, IntervalTree<Diagnostic>> = new Map();

  constructor(connection: Connection, context: WorkspaceFolderContext) {
    this.connection = connection;
    this.context = context;
  }

  public async doValidate(
    textDocument: TextDocument
  ): Promise<Map<string, Diagnostic[]>> {
    const docPath = new URL(textDocument.uri).pathname;
    let diagnostics: Map<string, Diagnostic[]> = new Map();
    try {
      const settings = await this.context.documentSettings.get(
        textDocument.uri
      );

      if (settings.ansibleLint.enabled) {
        const result = await exec(
          `${settings.ansibleLint.path} --offline --nocolor -f codeclimate ${docPath}`,
          {
            encoding: 'utf-8',
            cwd: new URL(this.context.workspaceFolder.uri).pathname,
          }
        );
        diagnostics = this.processReport(result.stdout);

        if (result.stderr) {
          this.connection.window.showErrorMessage(result.stderr);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        const execError = error as ExecException & {
          // according to the docs, these are always available
          stdout: string;
          stderr: string;
        };
        if (execError.code === 2) {
          diagnostics = this.processReport(execError.stdout);
        } else {
          this.connection.window.showErrorMessage(execError.message);
        }
      } else {
        this.connection.console.error(
          `Exception in AnsibleLint service: ${JSON.stringify(error)}`
        );
      }
    }
    // FIXME: validationCache gets duplicate records on each save
    diagnostics.forEach((fileDiagnostics, fileUri) => {
      if (!this.validationCache.has(fileUri)) {
        this.validationCache.set(fileUri, new IntervalTree<Diagnostic>());
      }
      const diagnosticTree = this.validationCache.get(
        fileUri
      ) as IntervalTree<Diagnostic>;
      for (const diagnostic of fileDiagnostics) {
        diagnosticTree.insert(
          [diagnostic.range.start.line, diagnostic.range.end.line],
          diagnostic
        );
      }
    });

    return diagnostics;
  }

  private processReport(result: string): Map<string, Diagnostic[]> {
    const diagnostics: Map<string, Diagnostic[]> = new Map();
    const report = JSON.parse(result);
    if (report instanceof Array) {
      for (const item of report) {
        if (
          typeof item.check_name === 'string' &&
          item.location &&
          typeof item.location.path === 'string' &&
          item.location.lines &&
          (item.location.lines.begin ||
            typeof item.location.lines.begin === 'number')
        ) {
          const begin_line =
            item.location.lines.begin.line || item.location.lines.begin || 1;
          const begin_column = item.location.lines.begin.column || 1;
          const start: Position = {
            line: begin_line - 1,
            character: begin_column - 1,
          };
          const end: Position = {
            line: begin_line - 1,
            character: Number.MAX_SAFE_INTEGER,
          };
          const range: Range = {
            start: start,
            end: end,
          };
          const locationUri = `${this.context.workspaceFolder.uri}/${item.location.path}`;
          if (!diagnostics.has(locationUri)) {
            diagnostics.set(locationUri, []);
          }
          const fileDiagnostics = diagnostics.get(locationUri) as Diagnostic[];

          fileDiagnostics.push({
            message: item.check_name,
            range: range || Range.create(0, 0, 0, 0),
            severity: DiagnosticSeverity.Error,
            source: 'Ansible',
          });
        }
      }
    }
    return diagnostics;
  }

  public invalidateCacheItems(
    fileUri: string,
    changes: TextDocumentContentChangeEvent[]
  ): void {
    const diagnosticTree = this.validationCache.get(fileUri);
    if (diagnosticTree) {
      for (const change of changes) {
        if ('range' in change) {
          const influencedDiagnostics = diagnosticTree.search([
            change.range.start.line,
            change.range.end.line,
          ]);
          if (influencedDiagnostics) {
            for (const diagnostic of influencedDiagnostics as Array<Diagnostic>) {
              diagnosticTree.remove(
                [diagnostic.range.start.line, diagnostic.range.end.line],
                diagnostic
              );
            }
          }
        }
      }
    }
  }

  public getValidationFromCache(fileUri: string): Diagnostic[] | undefined {
    return this.validationCache.get(fileUri)?.values;
  }
}