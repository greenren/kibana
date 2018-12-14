/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */
import fs from 'fs';
import { ResponseError } from 'vscode-jsonrpc';
import { ResponseMessage } from 'vscode-jsonrpc/lib/messages';
import { LanguageServerStatus } from '../../common/language_server';
import {
  LanguageServerNotInstalled,
  UnknownErrorCode,
  UnknownFileLanguage,
} from '../../common/lsp_error_codes';
import { LspRequest } from '../../model';
import { Logger } from '../log';
import { ServerOptions } from '../server_options';
import { detectLanguage } from '../utils/detect_language';
import { LoggerFactory } from '../utils/log_factory';
import { InstallManager } from './install_manager';
import { ILanguageServerLauncher } from './language_server_launcher';
import { LanguageServerDefinition, LanguageServers } from './language_servers';
import { ILanguageServerHandler } from './proxy';

export interface LanguageServerHandlerMap {
  [workspaceUri: string]: ILanguageServerHandler;
}

interface LanguageServerData {
  definition: LanguageServerDefinition;
  builtinWorkspaceFolders: boolean;
  maxWorkspace: number;
  languages: string[];
  launcher: ILanguageServerLauncher;
  languageServerHandlers?: ILanguageServerHandler | LanguageServerHandlerMap;
}

/**
 * Manage different LSP servers and forward request to different LSP using LanguageServerProxy, currently
 * we just use forward request to all the LSP servers we are running.
 */
export class LanguageServerController implements ILanguageServerHandler {
  // a list of support language servers
  private readonly languageServers: LanguageServerData[];
  // a { lang -> server } map from above list
  private readonly languageServerMap: { [lang: string]: LanguageServerData };
  private log: Logger;
  private readonly detach: boolean = process.env.LSP_DETACH === 'true';

  constructor(
    readonly options: ServerOptions,
    readonly targetHost: string,
    readonly installManager: InstallManager,
    readonly loggerFactory: LoggerFactory
  ) {
    this.log = loggerFactory.getLogger([]);
    this.languageServers = LanguageServers.map(def => ({
      definition: def,
      builtinWorkspaceFolders: def.builtinWorkspaceFolders,
      languages: def.languages,
      maxWorkspace: options.maxWorkspace,
      launcher: new def.launcher(this.targetHost, this.detach, options, loggerFactory),
    }));
    this.languageServerMap = this.languageServers.reduce(
      (map, ls) => {
        ls.languages.forEach(lang => (map[lang] = ls));
        map[ls.definition.name] = ls;
        return map;
      },
      {} as { [lang: string]: LanguageServerData }
    );
  }

  public async handleRequest(request: LspRequest) {
    const file = request.resolvedFilePath;
    if (file) {
      // #todo add test for this
      const lang = await detectLanguage(file.replace('file://', ''));
      return this.dispatchRequest(lang, request);
    } else {
      return Promise.reject(
        new ResponseError(UnknownErrorCode, `can't detect language without a file`)
      );
    }
  }

  public async dispatchRequest(lang: string, request: LspRequest): Promise<ResponseMessage> {
    if (lang) {
      const ls = this.findLanguageServer(lang);
      if (ls.builtinWorkspaceFolders) {
        if (!ls.launcher.running) {
          ls.languageServerHandlers = await ls.launcher.launch(
            ls.builtinWorkspaceFolders,
            ls.maxWorkspace,
            this.installManager.installationPath(ls.definition)
          );
        }
        const handler = ls.languageServerHandlers as ILanguageServerHandler;
        return handler.handleRequest(request);
      } else {
        const handler = await this.findOrCreateHandler(ls, request);
        handler.lastAccess = Date.now();
        return handler.handleRequest(request);
      }
    } else {
      return Promise.reject(
        new ResponseError(
          UnknownFileLanguage,
          `can't detect language from file:${request.resolvedFilePath}`
        )
      );
    }
  }

  /**
   * shutdown all language servers
   */
  public async exit() {
    for (const ls of this.languageServers) {
      if (ls.languageServerHandlers) {
        if (ls.builtinWorkspaceFolders) {
          if (ls.languageServerHandlers) {
            await (ls.languageServerHandlers as ILanguageServerHandler).exit();
          }
        } else {
          const handlers = ls.languageServerHandlers as LanguageServerHandlerMap;
          for (const handler of Object.values(handlers)) {
            await handler.exit();
          }
        }
      }
    }
  }

  public async launchServers() {
    for (const ls of this.languageServers) {
      const installed = this.installManager.status(ls.definition) === LanguageServerStatus.READY;
      // for those language server has builtin workspace support, we can launch them during kibana startup
      if (installed && ls.builtinWorkspaceFolders) {
        try {
          ls.languageServerHandlers = await ls.launcher.launch(
            true,
            ls.maxWorkspace,
            this.installManager.installationPath(ls.definition)
          );
        } catch (e) {
          this.log.error(e);
        }
      }
    }
  }

  public async unloadWorkspace(workspaceDir: string) {
    for (const languageServer of this.languageServers) {
      if (languageServer.languageServerHandlers) {
        if (languageServer.builtinWorkspaceFolders) {
          const handler = languageServer.languageServerHandlers as ILanguageServerHandler;
          await handler.unloadWorkspace(workspaceDir);
        } else {
          const handlers = languageServer.languageServerHandlers as LanguageServerHandlerMap;
          const realPath = fs.realpathSync(workspaceDir);
          const handler = handlers[realPath];
          if (handler) {
            await handler.unloadWorkspace(realPath);
            delete handlers[realPath];
          }
        }
      }
    }
  }

  public status(lang: string): LanguageServerStatus {
    const ls = this.languageServerMap[lang];
    const status = this.installManager.status(ls.definition);
    // installed, but is it running?
    if (status === LanguageServerStatus.READY) {
      if (ls.launcher.running) {
        return LanguageServerStatus.RUNNING;
      }
    }
    return status;
  }

  public supportLanguage(lang: string) {
    return this.languageServerMap[lang] !== undefined;
  }

  private async findOrCreateHandler(
    languageServer: LanguageServerData,
    request: LspRequest
  ): Promise<ILanguageServerHandler> {
    let handlers: LanguageServerHandlerMap;
    if (languageServer.languageServerHandlers) {
      handlers = languageServer.languageServerHandlers as LanguageServerHandlerMap;
    } else {
      handlers = languageServer.languageServerHandlers = {};
    }
    if (!request.workspacePath) {
      throw new ResponseError(UnknownErrorCode, `no workspace in request?`);
    }
    const realPath = fs.realpathSync(request.workspacePath);
    let handler = handlers[realPath];
    if (handler) {
      return handler;
    } else {
      const maxWorkspace = languageServer.maxWorkspace;
      const handlerArray = Object.entries(handlers);
      if (handlerArray.length < maxWorkspace) {
        handler = await languageServer.launcher.launch(
          languageServer.builtinWorkspaceFolders,
          maxWorkspace,
          this.installManager.installationPath(languageServer.definition)
        );
        handlers[realPath] = handler;
        return handler;
      } else {
        let [oldestWorkspace, oldestHandler] = handlerArray[0];
        handlerArray.forEach(p => {
          const [ws, h] = p;
          if (h.lastAccess! < oldestHandler.lastAccess!) {
            oldestWorkspace = ws;
            oldestHandler = h;
          }
        });
        delete handlers[oldestWorkspace];
        handlers[request.workspacePath] = oldestHandler;
        return oldestHandler;
      }
    }
  }

  private findLanguageServer(lang: string) {
    const ls = this.languageServerMap[lang];
    if (ls) {
      if (
        !this.detach &&
        this.installManager.status(ls.definition) !== LanguageServerStatus.READY
      ) {
        throw new ResponseError(
          LanguageServerNotInstalled,
          `language server ${lang} not installed`
        );
      } else {
        return ls;
      }
    } else {
      throw new ResponseError(UnknownFileLanguage, `unsupported language ${lang}`);
    }
  }
}
