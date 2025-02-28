const os = require("os");

const { validate } = require("schema-utils");
const serialize = require("serialize-javascript");
const { Worker } = require("jest-worker");

const schema = require("./options.json");

const { htmlMinifierTerser, throttleAll } = require("./utils");
const { minify } = require("./minify");

/** @typedef {import("schema-utils/declarations/validate").Schema} Schema */
/** @typedef {import("webpack").Compiler} Compiler */
/** @typedef {import("webpack").Compilation} Compilation */
/** @typedef {import("webpack").WebpackError} WebpackError */
/** @typedef {import("webpack").Asset} Asset */
/** @typedef {import("jest-worker").Worker} JestWorker */
/** @typedef {import("./utils.js").HtmlMinifierTerserOptions} HtmlMinifierTerserOptions */

/** @typedef {RegExp | string} Rule */

/** @typedef {Rule[] | Rule} Rules */

/**
 * @typedef {Object} MinimizedResult
 * @property {string} code
 * @property {Array<unknown>} [errors]
 * @property {Array<unknown>} [warnings]
 */

/**
 * @typedef {{ [file: string]: string }} Input
 */

/**
 * @typedef {{ [key: string]: any }} CustomOptions
 */

/**
 * @template T
 * @typedef {T extends infer U ? U : CustomOptions} InferDefaultType
 */

/**
 * @template T
 * @typedef {InferDefaultType<T> | undefined} MinimizerOptions
 */

/**
 * @template T
 * @callback MinimizerImplementation
 * @param {Input} input
 * @param {MinimizerOptions<T>} [minimizerOptions]
 * @returns {Promise<MinimizedResult>}
 */

/**
 * @template T
 * @typedef {Object} Minimizer
 * @property {MinimizerImplementation<T>} implementation
 * @property {MinimizerOptions<T> | undefined} [options]
 */

/**
 * @template T
 * @typedef {Object} InternalOptions
 * @property {string} name
 * @property {string} input
 * @property {T extends any[] ? { [P in keyof T]: Minimizer<T[P]>; } : Minimizer<T>} minimizer
 */

/**
 * @typedef InternalResult
 * @property {string} code
 * @property {Array<any>} warnings
 * @property {Array<any>} errors
 */

/**
 * @template T
 * @typedef {JestWorker & { transform: (options: string) => InternalResult, minify: (options: InternalOptions<T>) => InternalResult }} MinimizerWorker
 */

/**
 * @typedef {undefined | boolean | number} Parallel
 */

/**
 * @typedef {Object} BasePluginOptions
 * @property {Rules} [test]
 * @property {Rules} [include]
 * @property {Rules} [exclude]
 * @property {Parallel} [parallel]
 */

/**
 * @template T
 * @typedef {BasePluginOptions & { minimizer: T extends any[] ? { [P in keyof T]: Minimizer<T[P]> } : Minimizer<T> }} InternalPluginOptions
 */

/**
 * @template T
 * @typedef {T extends HtmlMinifierTerserOptions
 *  ? { minify?: MinimizerImplementation<T> | undefined, minimizerOptions?: MinimizerOptions<T> | undefined }
 *  : T extends any[]
 *    ? { minify: { [P in keyof T]: MinimizerImplementation<T[P]>; }, minimizerOptions?: { [P in keyof T]?: MinimizerOptions<T[P]> | undefined; } | undefined }
 *    : { minify: MinimizerImplementation<T>, minimizerOptions?: MinimizerOptions<T> | undefined }} DefinedDefaultMinimizerAndOptions
 */

/**
 * @template [T=HtmlMinifierTerserOptions]
 */
class HtmlMinimizerPlugin {
  /**
   * @param {BasePluginOptions & DefinedDefaultMinimizerAndOptions<T>} [options]
   */
  constructor(options) {
    validate(/** @type {Schema} */ (schema), options || {}, {
      name: "Html Minimizer Plugin",
      baseDataPath: "options",
    });

    const {
      minify = htmlMinifierTerser,
      minimizerOptions,
      parallel = true,
      test = /\.html(\?.*)?$/i,
      include,
      exclude,
    } = options || {};

    /** @type {T extends any[] ? { [P in keyof T]: Minimizer<T[P]>; } : Minimizer<T>} */
    let minimizer;

    if (Array.isArray(minify)) {
      // @ts-ignore
      minimizer =
        /** @type {MinimizerImplementation<T>[]} */
        (minify).map(
          /**
           * @param {MinimizerImplementation<T>} item
           * @param {number} i
           * @returns {Minimizer<T>}
           */
          (item, i) => {
            return {
              implementation: item,
              options: Array.isArray(minimizerOptions)
                ? minimizerOptions[i]
                : minimizerOptions,
            };
          }
        );
    } else {
      minimizer =
        /** @type {T extends any[] ? { [P in keyof T]: Minimizer<T[P]>; } : Minimizer<T>} */
        ({ implementation: minify, options: minimizerOptions });
    }

    /**
     * @private
     * @type {InternalPluginOptions<T>}
     */
    this.options = {
      test,
      parallel,
      include,
      exclude,
      minimizer,
    };
  }

  /**
   * @private
   * @param {any} warning
   * @param {string} file
   * @returns {Error}
   */
  static buildWarning(warning, file) {
    /**
     * @type {Error & { hideStack?: true, file?: string }}
     */
    const builtWarning = new Error(
      warning instanceof Error
        ? warning.message
        : typeof warning.message !== "undefined"
        ? warning.message
        : warning.toString()
    );

    builtWarning.name = "Warning";
    builtWarning.hideStack = true;
    builtWarning.file = file;

    return builtWarning;
  }

  /**
   * @private
   * @param {any} error
   * @param {string} file
   * @returns {Error}
   */
  static buildError(error, file) {
    /**
     * @type {Error & { file?: string }}
     */
    let builtError;

    if (typeof error === "string") {
      builtError = new Error(`${file} from Html Minimizer plugin\n${error}`);
      builtError.file = file;

      return builtError;
    }

    if (error.stack) {
      // @ts-ignore
      builtError = new Error(
        `${file} from Html Minimizer plugin\n${
          typeof error.message !== "undefined" ? error.message : ""
        }\n${error.stack}`
      );
      builtError.file = file;

      return builtError;
    }

    builtError = new Error(
      `${file} from Html Minimizer plugin\n${error.message}`
    );
    builtError.file = file;

    return builtError;
  }

  /**
   * @private
   * @param {Parallel} parallel
   * @returns {number}
   */
  static getAvailableNumberOfCores(parallel) {
    // In some cases cpus() returns undefined
    // https://github.com/nodejs/node/issues/19022
    const cpus = os.cpus() || { length: 1 };

    return parallel === true
      ? cpus.length - 1
      : Math.min(Number(parallel) || 0, cpus.length - 1);
  }

  /**
   * @private
   * @param {Compiler} compiler
   * @param {Compilation} compilation
   * @param {Record<string, import("webpack").sources.Source>} assets
   * @param {{availableNumberOfCores: number}} optimizeOptions
   * @returns {Promise<void>}
   */
  async optimize(compiler, compilation, assets, optimizeOptions) {
    const cache = compilation.getCache("HtmlMinimizerWebpackPlugin");
    let numberOfAssets = 0;
    const assetsForMinify = await Promise.all(
      Object.keys(assets)
        .filter((name) => {
          const { info } = /** @type {Asset} */ (compilation.getAsset(name));

          // Skip double minimize assets from child compilation
          if (info.minimized) {
            return false;
          }

          if (
            !compiler.webpack.ModuleFilenameHelpers.matchObject.bind(
              // eslint-disable-next-line no-undefined
              undefined,
              this.options
            )(name)
          ) {
            return false;
          }

          return true;
        })
        .map(async (name) => {
          const { info, source } = /** @type {Asset} */ (
            compilation.getAsset(name)
          );

          const eTag = cache.getLazyHashedEtag(source);
          const cacheItem = cache.getItemCache(name, eTag);
          const output = await cacheItem.getPromise();

          if (!output) {
            numberOfAssets += 1;
          }

          return { name, info, inputSource: source, output, cacheItem };
        })
    );

    if (assetsForMinify.length === 0) {
      return;
    }

    /** @type {undefined | (() => MinimizerWorker<T>)} */
    let getWorker;
    /** @type {undefined | MinimizerWorker<T>} */
    let initializedWorker;
    /** @type {undefined | number} */
    let numberOfWorkers;

    if (optimizeOptions.availableNumberOfCores > 0) {
      // Do not create unnecessary workers when the number of files is less than the available cores, it saves memory
      numberOfWorkers = Math.min(
        numberOfAssets,
        optimizeOptions.availableNumberOfCores
      );
      // eslint-disable-next-line consistent-return
      getWorker = () => {
        if (initializedWorker) {
          return initializedWorker;
        }

        initializedWorker =
          /** @type {MinimizerWorker<T>} */
          (
            new Worker(require.resolve("./minify"), {
              numWorkers: numberOfWorkers,
              enableWorkerThreads: true,
            })
          );

        // https://github.com/facebook/jest/issues/8872#issuecomment-524822081
        const workerStdout = initializedWorker.getStdout();

        if (workerStdout) {
          workerStdout.on("data", (chunk) => process.stdout.write(chunk));
        }

        const workerStderr = initializedWorker.getStderr();

        if (workerStderr) {
          workerStderr.on("data", (chunk) => process.stderr.write(chunk));
        }

        return initializedWorker;
      };
    }

    const { RawSource } = compiler.webpack.sources;
    const scheduledTasks = [];

    for (const asset of assetsForMinify) {
      scheduledTasks.push(async () => {
        const { name, inputSource, cacheItem } = asset;
        let { output } = asset;
        let input;

        const sourceFromInputSource = inputSource.source();

        if (!output) {
          input = sourceFromInputSource;

          if (Buffer.isBuffer(input)) {
            input = input.toString();
          }

          /**
           * @type {InternalOptions<T>}
           */
          const options = {
            name,
            input,
            minimizer: this.options.minimizer,
          };

          try {
            output = await (getWorker
              ? getWorker().transform(serialize(options))
              : minify(options));
          } catch (error) {
            compilation.errors.push(
              /** @type {WebpackError} */
              (HtmlMinimizerPlugin.buildError(error, name))
            );

            return;
          }

          output.source = new RawSource(output.code);

          await cacheItem.storePromise({
            source: output.source,
            errors: output.errors,
            warnings: output.warnings,
          });
        }

        const newInfo = { minimized: true };

        if (output.warnings && output.warnings.length > 0) {
          for (const warning of output.warnings) {
            compilation.warnings.push(
              /** @type {WebpackError} */
              (HtmlMinimizerPlugin.buildWarning(warning, name))
            );
          }
        }

        if (output.errors && output.errors.length > 0) {
          for (const error of output.errors) {
            compilation.errors.push(
              /** @type {WebpackError} */
              (HtmlMinimizerPlugin.buildError(error, name))
            );
          }
        }

        compilation.updateAsset(name, output.source, newInfo);
      });
    }

    const limit =
      getWorker && numberOfAssets > 0
        ? /** @type {number} */ (numberOfWorkers)
        : scheduledTasks.length;

    await throttleAll(limit, scheduledTasks);

    if (initializedWorker) {
      await initializedWorker.end();
    }
  }

  /**
   * @param {Compiler} compiler
   * @returns {void}
   */
  apply(compiler) {
    const pluginName = this.constructor.name;
    const availableNumberOfCores =
      HtmlMinimizerPlugin.getAvailableNumberOfCores(this.options.parallel);

    compiler.hooks.compilation.tap(pluginName, (compilation) => {
      compilation.hooks.processAssets.tapPromise(
        {
          name: pluginName,
          stage:
            compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE,
          additionalAssets: true,
        },
        (assets) =>
          this.optimize(compiler, compilation, assets, {
            availableNumberOfCores,
          })
      );

      compilation.hooks.statsPrinter.tap(pluginName, (stats) => {
        stats.hooks.print
          .for("asset.info.minimized")
          .tap(
            "html-minimizer-webpack-plugin",
            (minimized, { green, formatFlag }) =>
              minimized
                ? /** @type {Function} */ (green)(
                    /** @type {Function} */ (formatFlag)("minimized")
                  )
                : ""
          );
      });
    });
  }
}

HtmlMinimizerPlugin.htmlMinifierTerser = htmlMinifierTerser;

module.exports = HtmlMinimizerPlugin;
