/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BasePlugin, isWrapped } from '@opentelemetry/core';
import { StatusCode, Span } from '@opentelemetry/api';
import * as pgTypes from 'pg';
import * as shimmer from 'shimmer';
import {
  PgClientExtended,
  NormalizedQueryConfig,
  PostgresCallback,
} from './types';
import * as utils from './utils';
import { VERSION } from './version';

export class PostgresPlugin extends BasePlugin<typeof pgTypes> {
  static readonly COMPONENT = 'pg';
  static readonly DB_TYPE = 'sql';

  static readonly BASE_SPAN_NAME = PostgresPlugin.COMPONENT + '.query';

  readonly supportedVersions = ['7.*', '8.*'];

  constructor(readonly moduleName: string) {
    super('@opentelemetry/plugin-pg', VERSION);
    this._config = {};
  }

  protected patch(): typeof pgTypes {
    if (!isWrapped(this._moduleExports.Client.prototype.query)) {
      shimmer.wrap(
        this._moduleExports.Client.prototype,
        'query',
        this._getClientQueryPatch() as never
      );
    }
    return this._moduleExports;
  }

  protected unpatch(): void {
    shimmer.unwrap(this._moduleExports.Client.prototype, 'query');
  }

  private _getClientQueryPatch() {
    const plugin = this;
    return (original: typeof pgTypes.Client.prototype.query) => {
      plugin._logger.debug(
        `Patching ${PostgresPlugin.COMPONENT}.Client.prototype.query`
      );
      return function query(this: PgClientExtended, ...args: unknown[]) {
        let span: Span;

        // Handle different client.query(...) signatures
        if (typeof args[0] === 'string') {
          const query = args[0];
          if (args.length > 1 && args[1] instanceof Array) {
            const params = args[1];
            span = utils.handleParameterizedQuery.call(
              this,
              plugin._tracer,
              plugin._config,
              query,
              params
            );
          } else {
            span = utils.handleTextQuery.call(this, plugin._tracer, query);
          }
        } else if (typeof args[0] === 'object') {
          const queryConfig = args[0] as NormalizedQueryConfig;
          span = utils.handleConfigQuery.call(
            this,
            plugin._tracer,
            plugin._config,
            queryConfig
          );
        } else {
          return utils.handleInvalidQuery.call(
            this,
            plugin._tracer,
            original,
            ...args
          );
        }

        // Bind callback to parent span
        if (args.length > 0) {
          const parentSpan = plugin._tracer.getCurrentSpan();
          if (typeof args[args.length - 1] === 'function') {
            // Patch ParameterQuery callback
            args[args.length - 1] = utils.patchCallback(
              span,
              args[args.length - 1] as PostgresCallback
            );
            // If a parent span exists, bind the callback
            if (parentSpan) {
              args[args.length - 1] = plugin._tracer.bind(
                args[args.length - 1]
              );
            }
          } else if (
            typeof (args[0] as NormalizedQueryConfig).callback === 'function'
          ) {
            // Patch ConfigQuery callback
            let callback = utils.patchCallback(
              span,
              (args[0] as NormalizedQueryConfig).callback!
            );
            // If a parent span existed, bind the callback
            if (parentSpan) {
              callback = plugin._tracer.bind(callback);
            }

            // Copy the callback instead of writing to args.callback so that we don't modify user's
            // original callback reference
            args[0] = { ...(args[0] as object), callback };
          }
        }

        // Perform the original query
        const result: unknown = original.apply(this, args as never);

        // Bind promise to parent span and end the span
        if (result instanceof Promise) {
          return result
            .then((result: unknown) => {
              // Return a pass-along promise which ends the span and then goes to user's orig resolvers
              return new Promise(resolve => {
                span.end();
                resolve(result);
              });
            })
            .catch((error: Error) => {
              return new Promise((_, reject) => {
                span.setStatus({
                  code: StatusCode.ERROR,
                  message: error.message,
                });
                span.end();
                reject(error);
              });
            });
        }

        // else returns void
        return result; // void
      };
    };
  }
}

export const plugin = new PostgresPlugin(PostgresPlugin.COMPONENT);
