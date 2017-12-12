/**
 * Module for controlling and working with Kits.
 */ /** */

import * as vscode from 'vscode';
import * as path from 'path';

import * as proc from './proc';
import dirs from './dirs';
import * as logging from './logging';
import {StateManager} from './state';
import {fs} from './pr';

const log = logging.createLogger('kit');

type ProgressReporter = vscode.Progress<{message?: string}>;

/**
 * Representation of a CMake generator, along with a toolset and platform
 */
export interface CMakeGenerator {
  name: string;
  toolset?: string;
  platform?: string;
}

/**
 * Base of all kits. Just has a name.
 */
export interface BaseKit {
  /**
   * The name of the kit
   */
  name: string;

  /**
   * The preferred CMake generator for this kit
   */
  preferredGenerator?: CMakeGenerator;

  /**
   * Additional settings to pass to CMake
   */
  cmakeSettings?: {[key: string] : string};
}

/**
 * CompilerKits list compilers for each language. This will be used on platforms
 * with GCC or Clang
 */
export interface CompilerKit extends BaseKit {
  type: 'compilerKit';

  /**
   * The language compilers.
   *
   * The key `lang` is the language, as in `CMAKE_<lang>_COMPILER`.
   * The corresponding value is a path to a compiler for that language.
   */
  compilers: {[lang: string] : string}
}

/**
 * VSKits are associated with an installed Visual Studio on the system, and a
 * target architecture.
 */
export interface VSKit extends BaseKit {
  type: 'vsKit';

  /**
   * The visual studio name. This corresponds to a name returned by `vswhere`,
   * and is used to look up the path to the VS installation when the user
   * selects this kit
   */
  visualStudio: string;

  /**
   * The architecture for the kit. This is used when asking for the architecture
   * from the dev environment batch file.
   */
  visualStudioArchitecture: string;
}

/**
 * ToolchainKits just name a CMake toolchain file to use when configuring.
 */
export interface ToolchainKit extends BaseKit {
  type: 'toolchainKit';

  /**
   * Path to a CMake toolchain file.
   */
  toolchainFile: string;
}

/**
 * Tagged union of all the kit types
 */
export type Kit = CompilerKit | VSKit | ToolchainKit;

type MaybeCompilerKitPr = Promise<CompilerKit | null>;
/**
 * Convert a binary (by path) to a CompilerKit. This checks if the named binary
 * is a GCC or Clang compiler and gets its version. If it is not a compiler,
 * returns `null`.
 * @param bin Path to a binary
 * @returns A CompilerKit, or null if `bin` is not a known compiler
 */
export async function kitIfCompiler(bin: string, pr?: ProgressReporter): MaybeCompilerKitPr {
  const fname = path.basename(bin);
  // Check by filename what the compiler might be. This is just heuristic.
  const gcc_regex = /^gcc(-\d+(\.\d+(\.\d+)?)?)?(\.exe)?$/;
  const clang_regex = /^clang(-\d+(\.\d+(\.\d+)?)?)?(\.exe)?$/;
  const gcc_res = gcc_regex.exec(fname);
  const clang_res = clang_regex.exec(fname);
  if (gcc_res) {
    log.debug('Testing GCC-ish binary:', bin);
    if (pr)
      pr.report({message : `Getting GCC version for ${bin}`});
    const exec = await proc.execute(bin, [ '-v' ]).result;
    if (exec.retc != 0) {
      return null;
    }
    const last_line = exec.stderr.trim().split('\n').reverse()[0];
    const version_re = /^gcc version (.*?) .*/;
    const version_match = version_re.exec(last_line);
    if (version_match === null) {
      return null;
    }
    const version = version_match[1];
    const gxx_fname = fname.replace(/^gcc/, 'g++');
    const gxx_bin = path.join(path.dirname(bin), gxx_fname);
    const name = `GCC ${version}`;
    log.debug('Detected GCC compiler kit:', bin);
    if (await fs.exists(gxx_bin)) {
      return {
        type : 'compilerKit',
        name : name,
        compilers : {
          'CXX' : gxx_bin,
          'C' : bin,
        }
      };
    } else {
      return {
        type : 'compilerKit',
        name : name,
        compilers : {
          'C' : bin,
        }
      };
    }
  } else if (clang_res) {
    log.debug('Testing Clang-ish binary:', bin);
    if (pr)
      pr.report({message : `Getting Clang version for ${bin}`});
    const exec = await proc.execute(bin, [ '-v' ]).result;
    if (exec.retc != 0) {
      return null;
    }
    const first_line = exec.stderr.split('\n')[0];
    const version_re = /^clang version (.*?)[ -]/;
    const version_match = version_re.exec(first_line);
    if (version_match === null) {
      return null;
    }
    const version = version_match[1];
    const clangxx_fname = fname.replace(/^clang/, 'clang++');
    const clangxx_bin = path.join(path.dirname(bin), clangxx_fname);
    const name = `Clang ${version}`;
    log.debug('Detected Clang compiler kit:', bin);
    if (await fs.exists(clangxx_bin)) {
      return {
        type : 'compilerKit',
        name : name,
        compilers : {
          'C' : bin,
          'CXX' : clangxx_bin,
        },
      };
    } else {
      return {
        type : 'compilerKit',
        name : name,
        compilers : {
          'C' : bin,
        },
      };
    }
  } else {return null;}
}

/**
 * Scans a directory for compiler binaries.
 * @param dir Directory containing candidate binaries
 * @returns A list of CompilerKits found
 */
export async function scanDirForCompilerKits(dir: string, pr?: ProgressReporter) {
  log.debug('Scanning directory', dir, 'for compilers');
  try {
    const stat = await fs.stat(dir); if (!stat.isDirectory()) {
      console.log('Skipping scan of non-directory', dir);
      return [];
    }
  } catch (e) {
    log.warning('Failed to scan', dir, 'by exception:', e);
    if (e.code == 'ENOENT') {
      return [];
    }
    throw e;
  }
  // Get files in the directory
  if (pr) pr.report({message : `Checking ${dir} for compilers...`});
  const bins = (await fs.readdir(dir)).map(f => path.join(dir, f));
  // Scan each binary in parallel
  const prs
  = bins.map(async(bin) => {
      log.trace('Checking file for compiler-ness:', bin);
      try {
        return await kitIfCompiler(bin, pr);
      } catch (e) {
        log.warning('Failed to check binary', bin, 'by exception:', e);
        // The binary may not be executable by this user...
        if (e.code == 'EACCES') {
          return null;
        }
        throw e;
      }
    });
  const maybe_kits = await Promise.all(prs);
  const kits = maybe_kits.filter(k => k !== null) as Kit[];
  log.debug('Found', kits.length, 'kits in directory', dir);
  return kits;
}

/**
 * Description of a Visual Studio installation returned by vswhere.exe
 *
 * This isn't _all_ the properties, just the ones we need so far.
 */
export interface VSInstallation {
  instanceId : string; displayName : string; installationPath : string;
  installationVersion : string;
  description : string;
}

/**
 * Get a list of all Visual Studio installations available from vswhere.exe
 *
 * Will not include older versions. vswhere doesn't seem to list them?
 */
export async function
vsInstallations(): Promise<VSInstallation[]> {
  const pf_native = process.env['programfiles']; const pf_x86 = process.env['programfiles(x86)'];
  const installs = [] as VSInstallation[];
  const inst_ids = [] as string[];
  for (const progdir of[pf_native, pf_x86]) {
    if (!progdir) {
      continue;
    }
    const vswhere_exe = path.join(progdir, 'Microsoft Visual Studio/Installer/vswhere.exe');
    if (await fs.exists(vswhere_exe)) {
      const vswhere_res
          = await proc
                .execute(vswhere_exe,
                         [ '-all', '-format', 'json', '-products', '*', '-legacy', '-prerelease' ])
                .result;
      if (vswhere_res.retc !== 0) {
        log.error('Failed to execute vswhere.exe:', vswhere_res.stdout);
        continue;
      }
      const vs_installs = JSON.parse(vswhere_res.stdout) as VSInstallation[];
      for (const inst of vs_installs) {
        if (inst_ids.indexOf(inst.instanceId) < 0) {
          installs.push(inst);
          inst_ids.push(inst.instanceId)
        }
      }
    }
  } return installs;
}

/**
 * List of environment variables required for Visual C++ to run as expected for
 * a VS installation.
 */
const MSVC_ENVIRONMENT_VARIABLES
    = [
        'CL',
        '_CL_',
        'INCLUDE',
        'LIBPATH',
        'LINK',
        '_LINK_',
        'LIB',
        'PATH',
        'TMP',
        'FRAMEWORKDIR',
        'FRAMEWORKDIR64',
        'FRAMEWORKVERSION',
        'FRAMEWORKVERSION64',
        'UCRTCONTEXTROOT',
        'UCRTVERSION',
        'UNIVERSALCRTSDKDIR',
        'VCINSTALLDIR',
        'VCTARGETSPATH',
        'WINDOWSLIBPATH',
        'WINDOWSSDKDIR',
        'WINDOWSSDKLIBVERSION',
        'WINDOWSSDKVERSION',
      ];

/**
 * Get the environment variables corresponding to a VS dev batch file.
 * @param devbat Path to a VS environment batch file
 * @param args List of arguments to pass to the batch file
 */
async function collectDevBatVars(devbat: string, args: string[]):
    Promise<Map<string, string>| undefined> {
      const bat = [
        `@echo off`,
        `call "${devbat}" ${args.join(" ")} || exit`,
      ];
      for (const envvar of MSVC_ENVIRONMENT_VARIABLES) {
        bat.push(`echo ${envvar} := %${envvar}%`);
      }
      const fname = Math.random().toString() + '.bat';
      const batpath = path.join(dirs.tmpDir, `vs-cmt-${fname}`);
      await fs.writeFile(batpath, bat.join('\r\n'));
      const res = await proc.execute(batpath, [], null, {shell : true}).result;
      fs.unlink(batpath);
      const output = res.stdout;
      if (res.retc !== 0) {
        console.log(`Error running ${devbat}`, output);
        return;
      }
      if (output.includes("Invalid host architecture")
          || output.includes("Error in script usage")) {
        return;
      }
      if (!output) {
        console.log(`Environment detection for using ${devbat} failed`);
        return;
      }
      const vars = output.split('\n')
                       .map(l => l.trim())
                       .filter(l => l.length !== 0)
                       .reduce<Map<string, string>>((acc, line) => {
                         const mat = /(\w+) := ?(.*)/.exec(line);
                         if (mat) {
                           acc.set(mat[1], mat[2]);
                         } else {
                           console.error(`Error parsing environment variable: ${line}`);
                         }
                         return acc;
                       }, new Map());
      return vars;
    }

/**
 * Platform arguments for VS Generators
 */
const VsArchitectures: {[key: string] : string}
= {
    'amd64' : 'x64',
    'arm' : 'ARM',
    'amd64_arm' : 'ARM',
  };

/**
 * Preferred CMake VS generators by VS version
 */
const VsGenerators: {[key: string] : string} = {
  '15' : 'Visual Studio 15 2017',
  'VS120COMNTOOLS' : 'Visual Studio 12 2013',
  'VS140COMNTOOLS' : 'Visual Studio 14 2015',
};

async function varsForVSInstallation(inst: VSInstallation, arch: string):
    Promise<Map<string, string>| null> {
      const common_dir = path.join(inst.installationPath, 'Common7', 'Tools');
      const devbat = path.join(common_dir, 'VsDevCmd.bat');
      const variables = await collectDevBatVars(devbat, [ '-no_logo', `-arch=${arch}` ]);
      if (!variables) {
        return null;
      } else {
        return variables;
      }
    }

/**
 * Try to get a VSKit from a VS installation and architecture
 * @param inst A VS installation from vswhere
 * @param arch The architecture to try
 */
async function tryCreateNewVCEnvironment(inst: VSInstallation, arch: string, pr?: ProgressReporter):
    Promise<VSKit | null> {
      const name = inst.displayName + ' - ' + arch;
      log.debug('Checking for kit: ' + name);
      if (pr) {
        pr.report({message : `Checking ${inst.displayName} with ${arch}`});
      }
      const variables = await varsForVSInstallation(inst, arch);
      if (!variables)
        return null;

      const kit: VSKit = {
        type : 'vsKit',
        name : name,
        visualStudio : inst.displayName,
        visualStudioArchitecture : arch,
      };

      const version = /^(\d+)+./.exec(inst.installationVersion);
      if (version) {
        const generatorName: string | undefined = VsGenerators[version[1]];
        if (generatorName) {
          kit.preferredGenerator = {
            name : generatorName,
            platform : VsArchitectures[arch] as string || undefined,
          };
        }
      }

      return kit;
    }

/**
 * Scans the system for Visual C++ installations using vswhere
 */
export async function scanForVSKits(pr?: vscode.Progress<vscode.ProgressOptions>):
    Promise<VSKit[]> {
      const installs = await vsInstallations();
      const prs = installs.map(async(inst): Promise<VSKit[]> => {
        const ret = [] as VSKit[];
        const arches = [ 'x86', 'amd64', 'x86_amd64', 'x86_arm', 'amd64_arm', 'amd64_x86' ];
        const sub_prs = arches.map(arch => tryCreateNewVCEnvironment(inst, arch, pr));
        const maybe_kits = await Promise.all(sub_prs);
        maybe_kits.map(k => k ? ret.push(k) : null);
        return ret;
      });
      const vs_kits = await Promise.all(prs);
      return ([] as VSKit[]).concat(...vs_kits);
    }

export async function getVSKitEnvironment(kit: VSKit):
    Promise<Map<string, string>| null> {
      const installs = await vsInstallations();
      const requested = installs.find(inst => inst.displayName == kit.visualStudio);
      if (!requested) {
        return null;
      }
      return varsForVSInstallation(requested, kit.visualStudioArchitecture);
    }

/**
 * Search for Kits available on the platform.
 * @returns A list of Kits.
 */
export async function
scanForKits() {
  log.debug('Scanning for Kits on system');
  return vscode.window
      .withProgress({location : vscode.ProgressLocation.Window, title : 'Scanning for kits'},
                    async(pr) => {
                      pr.report({message : 'Scanning for CMake kits...'});
                      // Search directories on `PATH` for compiler binaries
                      const pathvar = process.env['PATH'] !;
                      const sep = process.platform === 'win32' ? ';' : ':';
                      const paths = pathvar.split(sep);
                      // Search them all in parallel
                      let prs = [] as Promise<Kit[]>[];
                      const compiler_kits = paths.map(path => scanDirForCompilerKits(path, pr));
                      prs = prs.concat(compiler_kits);
                      const vs_kits = scanForVSKits(pr);
                      prs.push(vs_kits);
                      const arrays = await Promise.all(prs);
                      const kits = ([] as Kit[]).concat(...arrays);
                      kits.map(k => log.info(`Found Kit: ${k.name}`));
                      return kits;
                    });
}

/**
 * Generates a string description of a kit. This is shown to the user.
 * @param kit The kit to generate a description for
 */
function descriptionForKit(kit: Kit) {
  switch (kit.type) {
  case 'toolchainKit': {
    return `Kit for toolchain file ${kit.toolchainFile}`;
  }
  case 'vsKit': {
    return `Using compilers for ${kit.visualStudio} (${kit.visualStudioArchitecture} architecture)`;
  }
  case 'compilerKit': {
    return 'Using compilers: '
        + Object.keys(kit.compilers).map(k => `\n  ${k} = ${kit.compilers[k]}`);
  }
  }
}

/**
 * Class that manages and tracks Kits
 */
export class KitManager implements vscode.Disposable {
  /**
   * The known kits
   */
  get kits() { return this._kits; }
  private _kits = [] as Kit[];

  /**
   * The path to the `cmake-kits.json` file
   */
  private get _kitsPath(): string { return path.join(dirs.dataDir, 'cmake-kits.json'); }

  /**
   * Watches the file at `_kitsPath`.
   */
  private _kitsWatcher = vscode.workspace.createFileSystemWatcher(this._kitsPath);

  /**
   * The active build kit
   */
  get activeKit() { return this._activeKit; }
  private _activeKit: Kit | null;

  /**
   * Event emitted when the Kit changes. This can be via user action, by the
   * available kits changing, or on initial load when the prior workspace kit
   * is reloaded.
   */
  get onActiveKitChanged() { return this._activeKitChangedEmitter.event; }
  private _activeKitChangedEmitter = new vscode.EventEmitter<Kit | null>();

  /**
   * Change the current kit. Commits the current kit name to workspace-local
   * persistent state so that the same kit is reloaded when the user opens
   * the workspace again.
   * @param kit The new Kit
   */
  private _setActiveKit(kit: Kit | null) {
    log.debug('Active kit set to', kit ? kit.name : 'null');
    if (kit) {
      this.stateManager.activeKitName = kit.name;
    } else {
      this.stateManager.activeKitName = null;
    }
    this._activeKit = kit;
    this._activeKitChangedEmitter.fire(kit);
  }

  /**
   * Create a new kit manager.
   * @param stateManager The workspace state manager
   */
  constructor(readonly stateManager: StateManager) {
    log.debug('Constructing KitManager');
    // Re-read the kits file when it is changed
    this._kitsWatcher.onDidChange(_e => this._rereadKits());
  }

  /**
   * Dispose the kit manager
   */
  dispose() {
    log.debug('Disposing KitManager');
    this._kitsWatcher.dispose();
    this._activeKitChangedEmitter.dispose();
  }

  /**
   * Shows a QuickPick that lets the user select a new kit.
   * @returns The selected Kit, or `null` if the user cancelled the selection
   * @note The user cannot reset the active kit to `null`. If they make no
   * selection, the current kit is kept. The only way it can reset to `null` is
   * if the active kit becomes somehow unavailable.
   */
  async selectKit(): Promise<Kit | null> {
    interface KitItem extends vscode.QuickPickItem {
      kit: Kit
    }
    log.debug('Opening kit selection QuickPick');
    const items = this._kits.map((kit): KitItem => {
      return {
        label : kit.name,
        description : descriptionForKit(kit),
        kit : kit,
      };
    });
    const chosen = await vscode.window.showQuickPick(items, {
      placeHolder : 'Select a Kit',
    });
    if (chosen === undefined) {
      log.debug('User cancelled Kit selection');
      // No selection was made
      return null;
    } else {
      this._setActiveKit(chosen.kit);
      return chosen.kit;
    }
  }

  async selectKitByName(kitName: string): Promise<Kit | null> {
    log.debug('Setting active Kit by name', kitName);
    const chosen = this._kits.find(k => k.name == kitName);
    if (chosen === undefined) {
      log.warning('Kit set by name to non-existent kit:', kitName);
      return null;
    } else {
      this._setActiveKit(chosen);
      return chosen;
    }
  }

  /**
   * Rescan the system for kits.
   *
   * This will update the `cmake-kits.json` file with any newly discovered kits,
   * and rewrite any previously discovered kits with the new data.
   */
  async rescanForKits() {
    log.debug('Rescanning for Kits');
    // clang-format off
    const old_kits_by_name = this._kits.reduce(
      (acc, kit) => Object.assign({}, acc, {[kit.name]: kit}),
      {} as{[kit: string]: Kit}
    );
    const discovered_kits = await scanForKits();
    const new_kits_by_name = discovered_kits.reduce(
      (acc, new_kit) => {
        acc[new_kit.name] = new_kit;
        return acc;
      },
      old_kits_by_name
    );
    // clang-format on

    const new_kits = Object.keys(new_kits_by_name).map(k => new_kits_by_name[k]);

    log.debug('Saving news kits to', this._kitsPath);
    await fs.mkdir_p(path.dirname(this._kitsPath));
    const stripped_kits = new_kits.map((k: any) => {
      k.type = undefined;
      return k;
    });
    const sorted_kits = stripped_kits.sort((a, b) => {
      if (a.name == b.name) {
        return 0;
      } else if (a.name < b.name) {
        return -1;
      } else {
        return 1;
      }
    });
    await fs.writeFile(this._kitsPath, JSON.stringify(sorted_kits, null, 2));
    log.debug(this._kitsPath, 'saved');
  }

  /**
   * Reread the `cmake-kits.json` file. This will be called if we write the
   * file in `rescanForKits`, or if the user otherwise edits the file manually.
   */
  private async _rereadKits() {
    log.debug('Re-reading kits file', this._kitsPath);
    const content_str = await fs.readFile(this._kitsPath);
    const content = JSON.parse(content_str.toLocaleString()) as object[];
    this._kits = content.map((item_): Kit => {
      if ('compilers' in item_) {
        const item = item_ as CompilerKit;
        return {
          type : 'compilerKit',
          name : item.name,
          compilers : item.compilers,
          preferredGenerator : item.preferredGenerator,
          cmakeSettings : item.cmakeSettings,
        };
      } else if ('toolchainFile' in item_) {
        const item = item_ as ToolchainKit;
        return {
          type : 'toolchainKit',
          name : item.name,
          toolchainFile : item.toolchainFile,
          preferredGenerator : item.preferredGenerator,
          cmakeSettings : item.cmakeSettings,
        };
      } else if ('visualStudio' in item_) {
        const item = item_ as VSKit;
        return {
          type : 'vsKit',
          name : item.name,
          visualStudio : item.visualStudio,
          visualStudioArchitecture : item.visualStudioArchitecture,
          preferredGenerator : item.preferredGenerator,
          cmakeSettings : item.cmakeSettings,
        };
      } else {
        vscode.window.showErrorMessage(
            'Your cmake-kits.json file contains one or more invalid entries.');
        throw new Error('Invalid kits');
      }
    });
    // Set the current kit to the one we have named
    const already_active_kit
        = this._kits.find((kit) => kit.name === this.stateManager.activeKitName);
    this._setActiveKit(already_active_kit || null);
  }

  /**
   * Initialize the kits manager. Must be called before using an instance.
   */
  async initialize() {
    log.debug('Second phase init for KitManager');
    if (await fs.exists(this._kitsPath)) {
      log.debug('Re-read kits file from prior session');
      // Load up the list of kits that we've saved
      await this._rereadKits();
    } else {
      await this.rescanForKits();
      interface DoOpen extends vscode.MessageItem {
        doOpen: boolean;
      }
      const item = await vscode.window.showInformationMessage<DoOpen>(
          'CMake Tools has scanned for available kits and saved them to a file. Would you like to edit the Kits file?',
          {},
          {title : "Yes", doOpen : true},
          {title : "No", isCloseAffordance : true, doOpen : false});
      if (item === undefined) {
        return;
      }
      if (item.doOpen) {
        this.openKitsEditor();
      }
    }
  }

  /**
   * Opens a text editor with the user-local `cmake-kits.json` file.
   */
  async openKitsEditor() {
    log.debug('Opening TextEditor for', this._kitsPath);
    const text = await vscode.workspace.openTextDocument(this._kitsPath);
    return await vscode.window.showTextDocument(text);
  }
}