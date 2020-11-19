/**
 * Copyright 2020 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { promises as fsp, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { promisify } from 'util';
import {
  parse as parsePath,
  resolve as resolvePath,
  dirname,
  normalize as nomalizePath,
} from 'path';

import postcss from 'postcss';
import postCSSNested from 'postcss-nested';
import postCSSUrl from 'postcss-url';
import postCSSModules from 'postcss-modules';
import postCSSSimpleVars from 'postcss-simple-vars';
import cssNano from 'cssnano';
import camelCase from 'lodash.camelcase';
import glob from 'glob';

const globP = promisify(glob);

const moduleSuffix = '.css';
const sourcePrefix = 'css:';
const addPrefix = 'add-css:';
const assetRe = new RegExp('/fake/path/to/asset/([^/]+)/', 'g');

const appendCssModule = '\0appendCss';
const appendCssSource = `
  export default function appendCss(css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
  }
`;

export default function (resolveFileUrl) {
  /** @type {string[]} */
  let emittedCSSIds;
  /** @type {Map<string, string>} */
  let hashToId;
  /** @type {Map<string, { module: string, css: string }>} */
  let pathToResult;

  return {
    name: 'css',
    async buildStart() {
      emittedCSSIds = [];
      hashToId = new Map();
      pathToResult = new Map();

      const cssPaths = (
        await globP('src/**/*.css', {
          nodir: true,
          absolute: true,
        })
      ).map((cssPath) =>
        // glob() returns windows paths with a forward slash. Normalise it:
        nomalizePath(cssPath),
      );

      await Promise.all(
        cssPaths.map(async (path) => {
          this.addWatchFile(path);
          const file = await fsp.readFile(path);
          let moduleJSON;

          const cssResult = await postcss([
            postCSSNested,
            postCSSSimpleVars(),
            postCSSModules({
              getJSON(_, json) {
                moduleJSON = json;
              },
              root: '',
            }),
            postCSSUrl({
              url: ({ relativePath, url }) => {
                if (/^(https?|data):/.test(url)) return url;
                const parsedPath = parsePath(relativePath);
                const source = readFileSync(
                  resolvePath(dirname(path), relativePath),
                );
                const fileId = this.emitFile({
                  type: 'asset',
                  name: parsedPath.base,
                  source,
                });
                const hash = createHash('md5');
                hash.update(source);
                const md5 = hash.digest('hex');
                hashToId.set(md5, fileId);
                return `/fake/path/to/asset/${md5}/`;
              },
            }),
            cssNano,
          ]).process(file, {
            from: path,
          });

          const cssClassExports = Object.entries(moduleJSON).map(
            ([key, val]) =>
              `export const ${camelCase(key)} = ${JSON.stringify(val)};`,
          );

          const defs =
            '// This file is autogenerated by lib/css-plugin.js\n' +
            Object.keys(moduleJSON)
              .map((key) => `export const ${camelCase(key)}: string;`)
              .join('\n');

          const defPath = path + '.d.ts';
          const currentDefFileContent = await fsp
            .readFile(defPath, { encoding: 'utf8' })
            .catch(() => undefined);

          // Only write the file if contents have changed, otherwise it causes a loop with
          // TypeScript's file watcher.
          if (defs !== currentDefFileContent) {
            await fsp.writeFile(defPath, defs);
          }

          pathToResult.set(path, {
            module: cssClassExports.join('\n'),
            css: cssResult.css,
          });
        }),
      );
    },
    async resolveId(id, importer) {
      if (id === appendCssModule) return id;

      const prefix = id.startsWith(sourcePrefix)
        ? sourcePrefix
        : id.startsWith(addPrefix)
        ? addPrefix
        : undefined;

      if (!prefix) return;

      const resolved = await this.resolve(id.slice(prefix.length), importer);
      if (!resolved) throw Error(`Couldn't resolve ${id} from ${importer}`);

      return prefix + resolved.id;
    },
    async load(id) {
      if (id === appendCssModule) return appendCssSource;
      if (id.startsWith(sourcePrefix)) {
        const path = nomalizePath(id.slice(sourcePrefix.length));

        if (!pathToResult.has(path)) {
          throw Error(`Cannot find ${path} in pathToResult`);
        }

        const cssStr = JSON.stringify(pathToResult.get(path).css).replace(
          assetRe,
          (match, hash) =>
            `" + import.meta.ROLLUP_FILE_URL_${hashToId.get(hash)} + "`,
        );

        return `export default ${cssStr};`;
      }
      if (id.startsWith(addPrefix)) {
        const path = id.slice(addPrefix.length);
        return (
          `import css from 'css:${path}';\n` +
          `import appendCss from '${appendCssModule}';\n` +
          `appendCss(css);\n`
        );
      }
      if (id.endsWith(moduleSuffix)) {
        if (!pathToResult.has(id)) {
          throw Error(`Cannot find ${id} in pathToResult`);
        }

        return pathToResult.get(id).module;
      }
    },
  };
}