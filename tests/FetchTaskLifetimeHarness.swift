import Foundation

private final class Counter: @unchecked Sendable {
  var value = 0
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else {
    fatalError(message)
  }
}

let requestQueue = DispatchQueue(label: "test.fetch-request-queue")
requestQueue.sync {
  let task = FetchTaskLifetime()
  let cancelCalls = Counter()
  let completions = Counter()
  let admittedStarts = Counter()
  func startOnce() -> FetchTaskLifetime.StartResult {
    let result = task.start()
    if result == .started { admittedStarts.value += 1 }
    return result
  }
  expect(startOnce() == .started, "first start must be admitted")
  expect(startOnce() == .alreadyStarted, "duplicate start must not start another URLSession task")
  expect(admittedStarts.value == 1, "a duplicate running start must not dispatch another task")
  task.cancelAndWait(cancelTask: { cancelCalls.value += 1 }, completion: { completions.value += 1 })
  task.cancelAndWait(cancelTask: { cancelCalls.value += 1 }, completion: { completions.value += 1 })
  expect(cancelCalls.value == 1, "repeated cancellation must call URLSessionTask.cancel once")
  expect(completions.value == 0, "cancel invocation must not release terminal waiters")
  task.didComplete()
  expect(completions.value == 2, "processed terminal completion must resolve every waiter")
  task.didComplete()
  expect(completions.value == 2, "terminal completion must resolve once")
  expect(startOnce() == .alreadyStarted, "a completed task must never be dispatched again")
  expect(admittedStarts.value == 1, "a completed duplicate start must not dispatch another task")
  task.cancelAndWait(cancelTask: { cancelCalls.value += 1 }, completion: { completions.value += 1 })
  expect(completions.value == 3, "waiter added after completion must resolve immediately")
  expect(cancelCalls.value == 1, "completed task must not be canceled again")

  let prestart = FetchTaskLifetime()
  let prestartCompletions = Counter()
  prestart.cancelAndWait(cancelTask: { prestartCompletions.value += 100 }, completion: { prestartCompletions.value += 1 })
  expect(prestartCompletions.value == 1, "never-started task cancellation must resolve immediately")
  expect(prestart.start() == .cancelledBeforeStart, "canceled-before-start task must not later dispatch")
  prestart.didComplete()
  expect(prestartCompletions.value == 1, "late completion after prestart cancellation must not double-resolve")
}

print("PASS Foundation fetch-task lifetime helper")
