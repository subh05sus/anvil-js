import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ansi } from './ansi.js';
import { GITIGNORE, TEMPLATES, TSCONFIG, getTemplate, type TemplateId } from './init-templates.js';

const ANVIL_ART = [
  '               _____________',
  '      ________/             \\',
  '_____/_______________________\\___',
  '\\_______________________________/',
  '         \\                 /',
  '          \\_______________/',
  '               |||||',
  '               |||||',
  '          _____|||||_____',
  '         /_______________\\',
  '         \\_______________/',
].join('\n');

function printBanner(): void {
  console.log();
  console.log(ansi.brand(ANVIL_ART));
  console.log(`  ${ansi.bold(ansi.brand('ANVIL'))}${ansi.dim(' — Express for humans. Anvil for agents.')}`);
  console.log();
}

export interface InitOptions {
  /** Project directory. Default: cwd. */
  dir?: string;
  template?: TemplateId;
  /** Skip the interactive prompt (defaults to 'basic' if --template is also omitted). */
  yes?: boolean;
}

const ANVIL_VERSION = '^1.0.0';
const ZOD_VERSION = '^3.23.8';
const BASE_SCRIPTS: Record<string, string> = {
  dev: 'anvil dev',
  build: 'anvil build',
  start: 'anvil start',
  lint: 'anvil lint',
};

export async function initCommand(options: InitOptions): Promise<void> {
  printBanner();

  const dir = path.resolve(options.dir ?? '.');
  await mkdir(dir, { recursive: true });

  const templateId = options.template ?? (await resolveTemplateInteractively(options));
  const template = getTemplate(templateId);

  console.log(`${ansi.dim('scaffolding')} ${ansi.bold(template.label)} ${ansi.dim('in')} ${dir === process.cwd() ? '.' : dir}\n`);

  await writePackageJson(dir, template);
  await writeIfMissing(path.join(dir, 'tsconfig.json'), TSCONFIG);
  await writeIfMissing(path.join(dir, '.gitignore'), GITIGNORE);

  let written = 0;
  let skipped = 0;
  for (const file of template.files) {
    const full = path.join(dir, file.path);
    if (existsSync(full)) {
      console.log(`  ${ansi.gray('–')} ${ansi.gray('skip')}    ${file.path} ${ansi.dim('(already exists)')}`);
      skipped++;
      continue;
    }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.content, 'utf8');
    console.log(`  ${ansi.green('✔')} ${ansi.green('create')}  ${file.path}`);
    written++;
  }

  console.log(`\n${ansi.bold(ansi.green(`${written} file(s) written`))}${skipped ? ansi.dim(`, ${skipped} skipped`) : ''}.`);
  console.log(`\n${ansi.cyan(template.hint)}\n`);
  console.log(ansi.bold('Next steps:'));
  console.log(`  ${ansi.dim('$')} npm install`);
  console.log(`  ${ansi.dim('$')} npm run dev`);
}

async function resolveTemplateInteractively(options: InitOptions): Promise<TemplateId> {
  if (options.yes || !process.stdin.isTTY) return 'basic';

  console.log(ansi.bold('Which template do you want to start from?\n'));
  TEMPLATES.forEach((t, i) =>
    console.log(`  ${ansi.brand(`${i + 1})`)} ${ansi.bold(t.label)} ${ansi.dim(`— ${t.description}`)}`),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`\n${ansi.dim(`Pick 1-${TEMPLATES.length} [1]:`)} `)).trim();
    const index = answer === '' ? 0 : Number(answer) - 1;
    return TEMPLATES[index]?.id ?? 'basic';
  } finally {
    rl.close();
  }
}

interface PackageJsonShape {
  name?: string;
  version?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

async function writePackageJson(dir: string, template: ReturnType<typeof getTemplate>): Promise<void> {
  const pkgPath = path.join(dir, 'package.json');
  let pkg: PackageJsonShape;
  let existed = false;

  if (existsSync(pkgPath)) {
    existed = true;
    pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as PackageJsonShape;
  } else {
    pkg = { name: path.basename(dir) || 'anvil-app', version: '0.0.1' };
  }

  pkg.type = 'module';
  pkg.scripts = { ...BASE_SCRIPTS, ...template.extraScripts, ...pkg.scripts };
  pkg.dependencies = {
    'anvil-js': ANVIL_VERSION,
    zod: ZOD_VERSION,
    ...template.extraDependencies,
    ...pkg.dependencies, // preserve existing pinned versions
  };

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  const tag = existed ? ansi.cyan('update') : ansi.green('create');
  const mark = existed ? ansi.cyan('✎') : ansi.green('✔');
  console.log(`  ${mark} ${tag}  package.json`);
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  if (existsSync(filePath)) return;
  await writeFile(filePath, content, 'utf8');
  console.log(`  ${ansi.green('✔')} ${ansi.green('create')}  ${path.basename(filePath)}`);
}
