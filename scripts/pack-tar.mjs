import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createPackTar({ pipelineId = 'transform', sampleId, packageJson, routeYml, pipelineYml, samplesYml, sampleData, readme, datagenConf, datagenData, datagenFileName, breakerYml }) {
  const tmpDir = join(__dirname, '..', `.tmp-pack-${randomBytes(4).toString('hex')}`);

  try {
    await mkdir(join(tmpDir, 'default', 'pipelines', pipelineId), { recursive: true });

    await writeFile(join(tmpDir, 'package.json'), JSON.stringify(packageJson, null, 2));
    await writeFile(join(tmpDir, 'default', 'pipelines', 'route.yml'), routeYml);
    await writeFile(join(tmpDir, 'default', 'pipelines', pipelineId, 'conf.yml'), pipelineYml);

    if (samplesYml && sampleData && sampleData.length > 0) {
      await mkdir(join(tmpDir, 'data', 'samples'), { recursive: true });
      await writeFile(join(tmpDir, 'default', 'samples.yml'), samplesYml);
      const fileId = sampleId || `${pipelineId}_sample`;
      const content = Array.isArray(sampleData) ? JSON.stringify(sampleData) : sampleData;
      await writeFile(join(tmpDir, 'data', 'samples', `${fileId}.json`), content);
    }

    if (datagenConf && datagenData && datagenFileName) {
      await mkdir(join(tmpDir, 'default', 'data', 'sources', 'datagen'), { recursive: true });
      await mkdir(join(tmpDir, 'default', 'data', 'datagen'), { recursive: true });
      await writeFile(join(tmpDir, 'default', 'data', 'sources', 'datagen', 'conf.yml'), datagenConf);
      await writeFile(join(tmpDir, 'default', 'data', 'datagen', datagenFileName), datagenData);
    }

    if (readme) {
      await writeFile(join(tmpDir, 'README.md'), readme);
    }

    if (breakerYml) {
      await writeFile(join(tmpDir, 'default', 'breakers.yml'), breakerYml);
    }

    const buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const tarArgs = ['--format=ustar', '-czf', '-', 'package.json', 'default'];
      if (samplesYml && sampleData && sampleData.length > 0) tarArgs.push('data');
      if (readme) tarArgs.push('README.md');
      const child = spawn('tar', tarArgs, {
        cwd: tmpDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`tar exited with code ${code}`));
      });
    });

    return buffer;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
