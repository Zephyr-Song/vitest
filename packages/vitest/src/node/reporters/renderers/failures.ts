import type {
  File,
  Task,
  TaskResultAttempt,
  Test,
  TestAnnotation,
} from '../../../runtime/runner/types'
import type { TestError } from '../../../types/general'
import { ordinal } from '@vitest/utils/helpers'
import { isRepeatReplay } from '../../../utils/tasks'

export function formatErrorAttempts(
  task: Task,
  attempts: (TaskResultAttempt | undefined)[],
): string {
  if (task.type === 'test' && task.result?.repeats) {
    return formatRepeatAttempts(task, attempts)
  }
  const showAttempt = (task.result?.attempts?.length ?? 0) > 1
  return [...Map.groupBy(attempts, (attempt) => attempt)]
    .map(([attempt, occurrences]) => {
      const label = showAttempt && attempt ? formatRetry(task, attempt.retryIndex) : ''
      const count = occurrences.length > 1 ? `${occurrences.length} times` : ''
      return count && label ? `${count} in ${label}` : count || label
    })
    .filter(Boolean)
    .join(', ')
}

const MAX_SHOWN_RANGES = 5

// The runs of 1 seed have 1 label, because the seed line shows if they failed with the same
// error. Other runs have a label for each kind of retry, with the repeats in ranges.
function formatRepeatAttempts(task: Test, attempts: (TaskResultAttempt | undefined)[]): string {
  const seededRepeats = new Set(
    attempts.flatMap((attempt) =>
      attempt?.seed && attempt.retryIndex === 0 ? [attempt.repeatIndex] : [],
    ),
  )
  const groups = Map.groupBy(
    attempts.filter((attempt) => attempt != null),
    (attempt) => (attempt.seed && seededRepeats.has(attempt.repeatIndex) ? 0 : attempt.retryIndex),
  )
  return [...groups]
    .flatMap(([retryIndex, group]) => {
      const repeatIndexes = [...new Set(group.map((attempt) => attempt.repeatIndex))]
      // 1 run can fail with the same error more than 1 time, for example with `expect.soft`
      const count = new Set(group).size === 1 && group.length > 1 ? `${group.length} times in ` : ''
      return formatRepeatRuns(task, retryIndex, repeatIndexes).map((run) => ({
        ...run,
        retryIndex,
        label: count + run.label,
      }))
    })
    .sort((a, b) => a.repeatIndex - b.repeatIndex || a.retryIndex - b.retryIndex)
    .map(({ label }) => label)
    .join(', ')
}

function formatRetry(task: Task, retryIndex: number): string {
  if (task.type === 'test' && isRepeatReplay(task, retryIndex)) {
    return 'replay of initial run'
  }
  return retryIndex ? `${ordinal(retryIndex)} retry` : 'initial run'
}

function formatRepeatRuns(
  task: Test,
  retryIndex: number,
  repeatIndexes: number[],
): { label: string; repeatIndex: number }[] {
  const repeats = repeatIndexes.filter((index) => index > 0).sort((a, b) => a - b)
  const labels =
    repeats.length < repeatIndexes.length
      ? [{ label: formatRetry(task, retryIndex), repeatIndex: 0 }]
      : []
  if (!repeats.length) {
    return labels
  }
  let text = `${ordinal(repeats[0])} repeat`
  if (repeats.length > 1) {
    const ranges: number[][] = []
    for (const index of repeats) {
      const range = ranges.at(-1)
      if (range && range[1] + 1 === index) {
        range[1] = index
      } else {
        ranges.push([index, index])
      }
    }
    const shown = ranges.slice(0, MAX_SHOWN_RANGES)
    const more = repeats.length - shown.reduce((sum, [start, end]) => sum + end - start + 1, 0)
    text = `repeats ${shown.map(([start, end]) => (start === end ? start : `${start}-${end}`)).join(', ')}`
    if (more) {
      text += ` and ${more} more`
    }
  }
  const replay = isRepeatReplay(task, retryIndex) ? 'replay' : ''
  const retry = replay || (retryIndex ? `${ordinal(retryIndex)} retry` : '')
  return [...labels, { label: retry ? `${retry} of ${text}` : text, repeatIndex: repeats[0] }]
}

// the annotations of the shown runs; a replay often adds the same annotation again
export function getShownAnnotations(
  task: Task,
  attempts: (TaskResultAttempt | undefined)[],
): TestAnnotation[] {
  if (task.type !== 'test') {
    return []
  }
  const shown = new Map<string, TestAnnotation>()
  for (const annotation of task.annotations) {
    const isShownRun =
      annotation.retryIndex == null ||
      attempts.some(
        (attempt) =>
          attempt?.retryIndex === annotation.retryIndex &&
          attempt?.repeatIndex === annotation.repeatIndex,
      )
    const { file, line, column } = annotation.location ?? {}
    const key = `${file}:${line}:${column} ${annotation.type} ${annotation.message}`
    if (isShownRun && !shown.has(key)) {
      shown.set(key, annotation)
    }
  }
  return [...shown.values()]
}

export interface ErrorGroup {
  error: TestError
  sources: ErrorSource[]
  otherMessages?: boolean
}

// with other messages, the shown error comes from the seed of the replay command
export function getShownError(group: ErrorGroup, replaySeed: string | undefined): TestError {
  if (!group.otherMessages) {
    return group.error
  }
  return group.sources.find(({ attempt }) => attempt?.seed === replaySeed)?.error ?? group.error
}

export function groupTaskErrors(tasks: Task[]): ErrorGroup[] {
  const groups: ErrorGroup[] = []

  for (const task of tasks) {
    // Merge identical errors
    for (const { error, attempt } of getErrorsWithAttempt(task)) {
      let previous: ErrorGroup | undefined

      if (error.stack) {
        previous = groups.find((item) => {
          if (item.error.stack !== error.stack || item.error.diff !== error.diff) {
            // other seeds of a test often fail at the same place with other values
            return isSameFailureWithOtherSeed(item, { task, attempt, error })
          }

          const itemTask = item.sources[0].task
          const currentProjectName = (task as File)?.projectName || task.file?.projectName || ''
          const projectName = (itemTask as File)?.projectName || itemTask.file?.projectName || ''

          const currentAnnotations = task.type === 'test' && task.annotations
          const itemAnnotations = itemTask.type === 'test' && itemTask.annotations

          return (
            projectName === currentProjectName && deepEqual(currentAnnotations, itemAnnotations)
          )
        })
      }

      if (previous) {
        previous.sources.push({ task, attempt, error })
        if (previous.error.stack !== error.stack || previous.error.diff !== error.diff) {
          previous.otherMessages = true
        }
      } else {
        groups.push({ error, sources: [{ task, attempt, error }] })
      }
    }
  }

  return groups
}

interface ErrorSource {
  task: Task
  // `undefined` for tasks without attempts (suites, files)
  attempt?: TaskResultAttempt
  error: TestError
}

// Seeds of a test with repeats that fail at the same place are 1 failure. The runs of 1 seed
// stay apart when their errors differ: then the seed does not reproduce the failure.
function isSameFailureWithOtherSeed(
  failure: { error: TestError; sources: ErrorSource[] },
  { task, attempt, error }: ErrorSource,
): boolean {
  if (task.type !== 'test' || !task.result?.repeats || !attempt?.seed) {
    return false
  }
  const location = getErrorLocation(error)
  if (
    location == null ||
    error.name !== failure.error.name ||
    location !== getErrorLocation(failure.error)
  ) {
    return false
  }
  return failure.sources.every(
    (source) =>
      source.task === task &&
      source.attempt?.seed &&
      (source.attempt.seed !== attempt.seed ||
        (source.error.stack === error.stack && source.error.diff === error.diff)),
  )
}

function getErrorLocation(error: TestError): string | undefined {
  const frame = error.stacks?.[0]
  return frame && `${frame.file}:${frame.line}:${frame.column}`
}

function getErrorsWithAttempt(task: Task): { error: TestError; attempt?: TaskResultAttempt }[] {
  const attempts = task.result?.attempts
  if (!attempts?.length) {
    return (task.result?.errors ?? []).map((error) => ({ error }))
  }
  return attempts.flatMap((attempt) => (attempt.errors ?? []).map((error) => ({ error, attempt })))
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) {
    return true
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }

  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) {
    return false
  }

  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !deepEqual(a[key], b[key])) {
      return false
    }
  }
  return true
}
