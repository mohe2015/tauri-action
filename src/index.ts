import { existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

import * as core from '@actions/core';
import { context } from '@actions/github';
import stringArgv from 'string-argv';

import { getOrCreateRelease } from './create-release';
import { uploadAssets as uploadReleaseAssets } from './upload-release-assets';
import { uploadVersionJSON } from './upload-version-json';
import { buildProject as buildDesktop } from './build-desktop';
import { buildProject as buildMobile } from './build-mobile';
import { execCommand, getInfo, getTargetInfo } from './utils';

import type { Artifact, BuildOptions, InitOptions } from './types';

async function run(): Promise<void> {
  try {
    const projectPath = resolve(
      process.cwd(),
      core.getInput('projectPath') || process.argv[2],
    );
    const distPath = core.getInput('distPath');
    const iconPath = core.getInput('iconPath');
    const appName = core.getInput('appName');
    const appVersion = core.getInput('appVersion');
    const includeRelease = core.getBooleanInput('includeRelease');
    const includeDebug = core.getBooleanInput('includeDebug');
    /*     const includeAndroid = core.getBooleanInput('includeAndroid');
    const includeIOS =
      process.platform === 'darwin' && core.getBooleanInput('includeIOS', {}); */
    const includeUpdaterJson = core.getBooleanInput('includeUpdaterJson');
    const updaterJsonKeepUniversal = core.getBooleanInput(
      'updaterJsonKeepUniversal',
    );
    const retryAttempts = parseInt(core.getInput('retryAttempts') || '0', 10);
    const tauriScript = core.getInput('tauriScript');
    const args = stringArgv(core.getInput('args'));
    const bundleIdentifier = core.getInput('bundleIdentifier');

    let tagName = core.getInput('tagName').replace('refs/tags/', '');
    let releaseId = Number(core.getInput('releaseId'));
    let releaseName = core.getInput('releaseName').replace('refs/tags/', '');
    let body = core.getInput('releaseBody');
    const owner = core.getInput('owner') || context.repo.owner;
    const repo = core.getInput('repo') || context.repo.repo;
    const draft = core.getBooleanInput('releaseDraft');
    const prerelease = core.getBooleanInput('prerelease');
    const commitish = core.getInput('releaseCommitish') || null;

    // TODO: Change its default to true for v2 apps
    // Not using getBooleanInput so we can differentiate between true,false,unset later.
    const updaterJsonPreferNsis =
      core.getInput('updaterJsonPreferNsis')?.toLowerCase() === 'true';

    // mobile
    const mobile = core.getInput('mobile').toLowerCase();
    // android should work on all runners but for `mobile: true` we only enable it for ubuntu runners. `mobile: android` enables it for all runners.
    const android =
      (process.platform === 'linux' && mobile === 'true') ||
      mobile === 'android';
    // iOS only works on macOS and therefore can be enabled the same with both `true` and `ios`
    const ios =
      process.platform === 'darwin' && (mobile === 'true' || mobile === 'ios');

    const buildOptions: BuildOptions = {
      tauriScript,
      args,
    };
    const initOptions: InitOptions = {
      distPath,
      iconPath,
      bundleIdentifier,
      appName,
      appVersion,
    };

    const targetArgIdx = [...args].findIndex(
      (e) => e === '-t' || e === '--target',
    );
    const targetPath =
      targetArgIdx >= 0 ? [...args][targetArgIdx + 1] : undefined;

    const configArgIdx = [...args].findIndex(
      (e) => e === '-c' || e === '--config',
    );
    const configArg =
      configArgIdx >= 0 ? [...args][configArgIdx + 1] : undefined;

    // We need to split release and debug artifacts for the updater json
    const releaseArtifacts: Artifact[] = [];
    const debugArtifacts: Artifact[] = [];
    const mobileArtifacts: Artifact[] = [];

    if (!android && !ios) {
      // desktop
      if (includeRelease) {
        releaseArtifacts.push(
          ...(await buildDesktop(
            projectPath,
            false,
            buildOptions,
            initOptions,
            retryAttempts,
          )),
        );
      }
      if (includeDebug) {
        debugArtifacts.push(
          ...(await buildDesktop(
            projectPath,
            true,
            buildOptions,
            initOptions,
            retryAttempts,
          )),
        );
      }
    } else if (android) {
      if (includeRelease) {
        mobileArtifacts.push(
          ...(await buildMobile(projectPath, true, false, buildOptions)),
        );
      }
      if (includeDebug) {
        mobileArtifacts.push(
          ...(await buildMobile(projectPath, true, true, buildOptions)),
        );
      }
    } else if (ios) {
      if (includeRelease) {
        mobileArtifacts.push(
          ...(await buildMobile(projectPath, false, false, buildOptions)),
        );
      }
      if (includeDebug) {
        mobileArtifacts.push(
          ...(await buildMobile(projectPath, false, true, buildOptions)),
        );
      }
    }

    const artifacts = releaseArtifacts
      .concat(debugArtifacts)
      .concat(mobileArtifacts);

    if (artifacts.length === 0) {
      if (releaseId || tagName) {
        throw new Error('No artifacts were found.');
      } else {
        console.log(
          'No artifacts were found. The action was not configured to upload artifacts, therefore this is not handled as an error.',
        );
        return;
      }
    }

    console.log(`Found artifacts:\n${artifacts.map((a) => a.path).join('\n')}`);
    core.setOutput(
      'artifactPaths',
      JSON.stringify(artifacts.map((a) => a.path)),
    );

    const targetInfo = getTargetInfo(targetPath);
    const info = getInfo(projectPath, targetInfo, configArg);
    core.setOutput('appVersion', info.version);

    // Other steps may benefit from this so we do this whether or not we want to upload it.
    if (targetInfo.platform === 'macos') {
      let i = 0;
      for (const artifact of artifacts) {
        // updater provide a .tar.gz, this will prevent duplicate and overwriting of
        // signed archive
        if (
          artifact.path.endsWith('.app') &&
          !existsSync(`${artifact.path}.tar.gz`)
        ) {
          console.log(
            `Packaging ${artifact.path} directory into ${artifact.path}.tar.gz`,
          );

          await execCommand('tar', [
            'czf',
            `${artifact.path}.tar.gz`,
            '-C',
            dirname(artifact.path),
            basename(artifact.path),
          ]);
          artifact.path += '.tar.gz';
        } else if (artifact.path.endsWith('.app')) {
          // we can't upload a directory
          artifacts.splice(i, 1);
        }
        i++;
      }
    }

    // If releaseId is set we'll use this to upload the assets to.
    // If tagName is set we will try to upload assets to the release associated with the given tagName.
    // If there's no release for that tag, we require releaseName to create a new one.
    if (tagName && !releaseId) {
      const templates = [
        {
          key: '__VERSION__',
          value: info.version,
        },
      ];

      templates.forEach((template) => {
        const regex = new RegExp(template.key, 'g');
        tagName = tagName.replace(regex, template.value);
        releaseName = releaseName.replace(regex, template.value);
        body = body.replace(regex, template.value);
      });

      const releaseData = await getOrCreateRelease(
        owner,
        repo,
        tagName,
        releaseName || undefined,
        body,
        commitish || undefined,
        draft,
        prerelease,
      );
      releaseId = releaseData.id;
      core.setOutput('releaseUploadUrl', releaseData.uploadUrl);
      core.setOutput('releaseId', releaseData.id.toString());
      core.setOutput('releaseHtmlUrl', releaseData.htmlUrl);
    }

    if (releaseId) {
      await uploadReleaseAssets(owner, repo, releaseId, artifacts);

      if (includeUpdaterJson) {
        await uploadVersionJSON({
          owner,
          repo,
          version: info.version,
          notes: body,
          tagName,
          releaseId,
          artifacts:
            releaseArtifacts.length !== 0 ? releaseArtifacts : debugArtifacts,
          targetInfo,
          unzippedSig: info.unzippedSigs,
          updaterJsonPreferNsis,
          updaterJsonKeepUniversal,
        });
      }
    } else {
      console.log('No releaseId or tagName provided, skipping all uploads...');
    }
  } catch (error) {
    // @ts-expect-error Catching errors in typescript is a headache
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    core.setFailed(error.message);
  }
}

await run();
