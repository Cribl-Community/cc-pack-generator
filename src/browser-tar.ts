interface TarEntry {
  name: string;
  content: string;
}

function encodeString(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function createTarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);

  // name (0-99)
  const nameBytes = encodeString(name);
  header.set(nameBytes.slice(0, 100), 0);

  // mode (100-107) — 0644
  header.set(encodeString('0000644\0'), 100);

  // uid (108-115)
  header.set(encodeString('0001000\0'), 108);

  // gid (116-123)
  header.set(encodeString('0001000\0'), 116);

  // size (124-135) — octal, 11 chars + null
  const sizeOctal = size.toString(8).padStart(11, '0');
  header.set(encodeString(sizeOctal + '\0'), 124);

  // mtime (136-147) — current time in octal
  const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
  header.set(encodeString(mtime + '\0'), 136);

  // checksum placeholder (148-155) — spaces
  header.set(encodeString('        '), 148);

  // typeflag (156) — '0' for regular file
  header[156] = 48; // '0'

  // magic (257-262) — 'ustar\0'
  header.set(encodeString('ustar\0'), 257);

  // version (263-264) — '00'
  header.set(encodeString('00'), 263);

  // Calculate checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  const checksumOctal = checksum.toString(8).padStart(6, '0');
  header.set(encodeString(checksumOctal + '\0 '), 148);

  return header;
}

function createDirHeader(name: string): Uint8Array {
  const header = new Uint8Array(512);
  const dirName = name.endsWith('/') ? name : name + '/';
  header.set(encodeString(dirName).slice(0, 100), 0);
  header.set(encodeString('0000755\0'), 100);
  header.set(encodeString('0001000\0'), 108);
  header.set(encodeString('0001000\0'), 116);
  header.set(encodeString('00000000000\0'), 124);
  const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
  header.set(encodeString(mtime + '\0'), 136);
  header.set(encodeString('        '), 148);
  header[156] = 53; // '5' for directory
  header.set(encodeString('ustar\0'), 257);
  header.set(encodeString('00'), 263);

  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.set(encodeString(checksum.toString(8).padStart(6, '0') + '\0 '), 148);

  return header;
}

export function createTarBlob(entries: TarEntry[]): Blob {
  const parts: Uint8Array[] = [];

  // Collect unique directories
  const dirs = new Set<string>();
  for (const entry of entries) {
    const segments = entry.name.split('/');
    for (let i = 1; i < segments.length; i++) {
      dirs.add(segments.slice(0, i).join('/') + '/');
    }
  }
  // Add directory headers
  const sortedDirs = [...dirs].sort();
  for (const dir of sortedDirs) {
    parts.push(createDirHeader(dir));
  }

  // Add file entries
  for (const entry of entries) {
    const content = encodeString(entry.content);
    parts.push(createTarHeader(entry.name, content.length));
    parts.push(content);
    // Pad to 512-byte boundary
    const padding = 512 - (content.length % 512);
    if (padding < 512) {
      parts.push(new Uint8Array(padding));
    }
  }

  // End-of-archive: two 512-byte zero blocks
  parts.push(new Uint8Array(1024));

  // TypeScript 6 models Uint8Array buffers as ArrayBufferLike, while BlobPart
  // requires an ArrayBuffer-backed view. Copy the locally-built TAR chunks so
  // the Blob receives unambiguously ArrayBuffer-backed data.
  const blobParts = parts.map(part => new Uint8Array(part).buffer);
  return new Blob(blobParts, { type: 'application/octet-stream' });
}

export async function buildPackCrbl(opts: {
  packId: string;
  pipelineId: string;
  sampleId?: string;
  packageJson: any;
  routeYml: string;
  pipelineYml: string;
  samplesYml?: string;
  sampleData?: any[];
  readme?: string | null;
  datagenConf?: string | null;
  datagenData?: string | null;
  datagenFileName?: string | null;
  breakerYml?: string | null;
}): Promise<Blob> {
  const entries: TarEntry[] = [];

  entries.push({ name: 'package.json', content: JSON.stringify(opts.packageJson, null, 2) });
  entries.push({ name: 'default/pipelines/route.yml', content: opts.routeYml });
      entries.push({ name: `default/pipelines/${opts.pipelineId}/conf.yml`, content: opts.pipelineYml });

  if (opts.breakerYml) {
    entries.push({ name: 'default/breakers.yml', content: opts.breakerYml });
  }

  if (opts.samplesYml && opts.sampleData && opts.sampleData.length > 0) {
    const sampleId = opts.sampleId || `${opts.pipelineId}_sample`;
    entries.push({ name: 'default/samples.yml', content: opts.samplesYml });
    entries.push({ name: `data/samples/${sampleId}.json`, content: JSON.stringify(opts.sampleData) });
  }

  if (opts.readme) {
    entries.push({ name: 'README.md', content: opts.readme });
  }

  if (opts.datagenConf && opts.datagenData && opts.datagenFileName) {
    entries.push({ name: 'default/data/sources/datagen/conf.yml', content: opts.datagenConf });
    entries.push({ name: `default/data/datagen/${opts.datagenFileName}`, content: opts.datagenData });
  }

  const tarBlob = createTarBlob(entries);

  // Gzip the tar — Cribl requires .crbl to be gzipped
  const cs = new CompressionStream('gzip');
  const compressedStream = tarBlob.stream().pipeThrough(cs);
  return new Response(compressedStream).blob();
}
