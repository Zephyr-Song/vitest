import type { TaskResultAttempt, Test } from '../../../runtime/runner/types'
import type { CLIOption } from '../../cli/cli-config'
import { escapeRegExp } from '../../../utils/base'
import { countSameFailures } from '../../../utils/tasks'
import { cliOptionsConfig } from '../../cli/cli-config'

const MAX_SHOWN_SEEDS = 3

// the first seed that failed with the same error on every run
export function getReplaySeed(
  test: Test,
  attempts: (TaskResultAttempt | undefined)[],
): string | undefined {
  const seeds = getSeeds(attempts)
  return seeds.find((seed) => isReproduced(getSeedRuns(test, seed))) ?? seeds[0]
}

export function getSeeds(attempts: (TaskResultAttempt | undefined)[]): string[] {
  return [...new Set(attempts.flatMap((attempt) => (attempt?.seed ? [attempt.seed] : [])))]
}

// the first run of the seed, and its replay or retries
export function getSeedRuns(test: Test, seed: string): TaskResultAttempt[] {
  return (test.result?.attempts ?? []).filter((run) => run.seed === seed)
}

function isReproduced(runs: TaskResultAttempt[]): boolean {
  return countSameFailures(runs) === runs.length
}

export function formatSeedList(seeds: string[]): string {
  const shown = seeds.slice(0, MAX_SHOWN_SEEDS).join(', ')
  const more = seeds.length - MAX_SHOWN_SEEDS
  return more > 0 ? `${shown} and ${more} more` : shown
}

export function getFailedSeeds(test: Test): string[] | undefined {
  const seeds = new Set<string>()
  for (const attempt of test.result?.attempts ?? []) {
    if (attempt.state === 'fail' && attempt.seed) {
      seeds.add(attempt.seed)
    }
  }
  return seeds.size ? [...seeds] : undefined
}

export function formatReplayCommand(
  test: Test,
  seed: string,
  runSeed: number | null,
  cliArgs: string[],
): string {
  const args = ['vitest', 'run', quote(test.file.name)]
  args.push('-t', quote(`^${escapeRegExp(test.fullTestName)}$`))
  if (test.file.projectName) {
    args.push('--project', quote(test.file.projectName))
  }
  args.push(...getReplayArgs(cliArgs).map(quote))
  // fixtures of file and worker scope and suite hooks get their values from the run seed
  if (runSeed != null) {
    args.push('--seed', String(runSeed))
  }
  args.push('--replay-seed', seed)
  return args.join(' ')
}

// the replay command selects the test and sets the seeds itself
const REPLACED_OPTIONS = new Set([
  'testNamePattern',
  'project',
  'shard',
  'changed',
  'sinceLastRun',
  'lastFailed',
  'seed',
  'repeats',
  'replaySeed',
  'watch',
  'run',
  'standalone',
  'mergeReports',
])

interface CliFlag {
  option: string
  hasValue: boolean
}

let cliFlags: Map<string, CliFlag> | undefined

function getReplayArgs(cliArgs: string[]): string[] {
  const flags = (cliFlags ??= getCliFlags(cliOptionsConfig))
  const args: string[] = []
  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i]
    if (arg === '--') {
      break
    }
    // the command name and the file filters
    if (!arg.startsWith('-')) {
      continue
    }
    const [name, value] = arg.split(/=(.*)/s)
    let flag = flags.get(camelCase(name))
    const negated = !flag && name.startsWith('--no-')
    if (negated) {
      flag = flags.get(camelCase(`--${name.slice(5)}`))
    }
    const next = cliArgs[i + 1]
    // an unknown flag takes the next value, as in `mri`
    const hasValue = !negated && value === undefined && (flag?.hasValue ?? true)
    const tokens =
      hasValue && next !== undefined && !next.startsWith('-') ? [arg, cliArgs[++i]] : [arg]
    if (!flag || !REPLACED_OPTIONS.has(flag.option)) {
      args.push(...tokens)
    }
  }
  return args
}

function getCliFlags(
  options: Record<string, CLIOption<any> | null>,
  flags = new Map<string, CliFlag>(),
  prefix = '',
  root?: string,
): Map<string, CliFlag> {
  for (const [key, option] of Object.entries(options)) {
    if (!option) {
      continue
    }
    const name = prefix + (option.alias || key)
    const flag = { option: root ?? key, hasValue: 'argument' in option && !!option.argument }
    flags.set(camelCase(`--${name}`), flag)
    if (option.shorthand) {
      flags.set(`-${option.shorthand}`, flag)
    }
    if ('subcommands' in option && option.subcommands) {
      getCliFlags(option.subcommands, flags, `${name}.`, root ?? key)
    }
  }
  return flags
}

// `cac` accepts both `--test-name-pattern` and `--testNamePattern`
function camelCase(flag: string): string {
  return flag.replace(/([a-z])-([a-z])/g, (_, before: string, after: string) => {
    return before + after.toUpperCase()
  })
}

function quote(value: string): string {
  if (/^[\w./@:=,-]+$/.test(value)) {
    return value
  }
  // PowerShell expands `$name` inside double quotes, its escape character is a backtick
  if (process.platform === 'win32') {
    return `"${value.replace(/[`"$]/g, '`$&')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}
