export type NativeCaptureFacts = {
  isRecording: boolean;
  statusRecording: boolean;
  canRecord: boolean;
  recoveryRequired?: boolean;
};

export type NativeCaptureOutcome = {
  state: 'recording' | 'paused' | 'recovery' | 'uncertain';
  canResume: boolean;
  generation: number;
  message?: string;
};

export type NativeCaptureIO = {
  record(): void;
  pause(): void;
  setRecordingEnabled(enabled: boolean): Promise<void>;
  readFacts(): NativeCaptureFacts;
};

function validFacts(value: unknown): value is NativeCaptureFacts {
  if (!value || typeof value !== 'object') return false;
  const facts = value as Partial<NativeCaptureFacts>;
  return typeof facts.isRecording === 'boolean' && typeof facts.statusRecording === 'boolean' &&
    typeof facts.canRecord === 'boolean' && facts.isRecording === facts.statusRecording &&
    (!facts.isRecording || facts.canRecord) &&
    (facts.recoveryRequired === undefined || typeof facts.recoveryRequired === 'boolean');
}

function classify(facts: NativeCaptureFacts, generation: number): NativeCaptureOutcome {
  if (!validFacts(facts)) return { state: 'uncertain', canResume: false, generation };
  if (facts.recoveryRequired) {
    return facts.isRecording && facts.statusRecording
      ? { state: 'uncertain', canResume: false, generation }
      : { state: 'recovery', canResume: false, generation };
  }
  if (facts.isRecording && facts.statusRecording) return { state: 'recording', canResume: false, generation };
  if (!facts.isRecording && !facts.statusRecording) {
    return facts.canRecord
      ? { state: 'paused', canResume: true, generation }
      : { state: 'recovery', canResume: false, generation };
  }
  return { state: 'uncertain', canResume: false, generation };
}

/** Coordinates native recorder intent with the OS recording-mode gate. It owns no queue or timer. */
export class NativeCaptureLifecycle {
  private generation = 0;
  private closing = false;
  private mode: 'enabled' | 'disabled' | 'unknown' = 'unknown';
  private intent: 'recording' | 'paused' | 'stopped' = 'stopped';
  private reconcilePromise?: Promise<NativeCaptureOutcome | null>;

  constructor(private io: NativeCaptureIO = {
    record: () => { throw new Error('Native recorder adapter is not configured.'); },
    pause: () => { throw new Error('Native recorder adapter is not configured.'); },
    setRecordingEnabled: async () => { throw new Error('Native recorder adapter is not configured.'); },
    readFacts: () => { throw new Error('Native recorder adapter is not configured.'); },
  }) {}

  setIO(io: NativeCaptureIO): void { this.io = io; }

  isCurrent(generation: number): boolean { return !this.closing && generation === this.generation; }

  close(): void { this.closing = true; this.generation += 1; }

  finish(): void { this.intent = 'stopped'; this.close(); }

  async start(): Promise<NativeCaptureOutcome> {
    const generation = ++this.generation;
    this.closing = false;
    this.intent = 'recording';
    try {
      await this.setMode(true, generation);
      if (!this.isCurrent(generation)) return this.uncertain(generation);
      this.io.record();
      if (!this.isCurrent(generation)) return this.uncertain(generation);
      const outcome = this.readOutcome(generation);
      if (outcome.state === 'recording') return outcome;
      if (this.isCurrent(generation)) this.intent = 'paused';
      return await this.disableAndRecheck(generation, 'Recording did not start as expected. Stop or discard the interrupted recording.');
    } catch {
      if (!this.isCurrent(generation)) return this.uncertain(generation);
      this.intent = 'paused';
      return this.disableAndRecheck(generation, 'Recording could not be confirmed. Stop or discard the interrupted recording.');
    }
  }

  async pause(): Promise<NativeCaptureOutcome> {
    const generation = ++this.generation;
    this.intent = 'paused';
    try { this.io.pause(); } catch { /* Continue to disable and inspect native state. */ }
    return this.disableAndRecheck(generation, 'Pause could not be confirmed. Stop or discard the recording.');
  }

  async resume(): Promise<NativeCaptureOutcome> {
    const generation = ++this.generation;
    this.intent = 'recording';
    try {
      await this.setMode(true, generation);
      if (!this.isCurrent(generation)) return this.uncertain(generation);
      this.io.record();
      if (!this.isCurrent(generation)) return this.uncertain(generation);
      const outcome = this.readOutcome(generation);
      if (outcome.state === 'recording') return outcome;
      if (this.isCurrent(generation)) this.intent = 'paused';
    } catch { /* A failed resume still needs a gated status check. */ }
    if (!this.isCurrent(generation)) return this.uncertain(generation);
    this.intent = 'paused';
    return this.disableAndRecheck(generation, 'Resume could not be confirmed. Stop or discard the recording.');
  }

  reconcile(): Promise<NativeCaptureOutcome | null> {
    if (this.reconcilePromise) return this.reconcilePromise;
    const generation = this.generation;
    const task = this.reconcileCurrent(generation).finally(() => {
      if (this.reconcilePromise === task) this.reconcilePromise = undefined;
    });
    this.reconcilePromise = task;
    return task;
  }

  private async reconcileCurrent(generation: number): Promise<NativeCaptureOutcome | null> {
    if (!this.isCurrent(generation) || this.intent === 'stopped') return null;
    const current = this.readOutcome(generation);
    if (current.state === 'uncertain') {
      return this.disableAndRecheck(generation, 'Recorder status is uncertain. Stop or discard the recording.');
    }
    if (this.intent === 'recording' && current.state === 'recording' && this.mode === 'enabled') return current;
    if (this.intent === 'paused' && (current.state === 'paused' || current.state === 'recovery')) {
      return this.mode === 'disabled' ? current : this.uncertain(generation, 'Recording mode could not be confirmed off. Stop or discard the recording.');
    }
    if (this.intent === 'recording' && (current.state === 'paused' || current.state === 'recovery')) {
      this.intent = 'paused';
      return this.disableAndRecheck(generation, 'Recording was interrupted. Stop or discard the recoverable audio.');
    }
    if (this.intent === 'paused' && current.state === 'recording') {
      return this.disableAndRecheck(generation, 'The device resumed recording unexpectedly. Recording mode was disabled.');
    }
    return current;
  }

  private async disableAndRecheck(generation: number, message: string): Promise<NativeCaptureOutcome> {
    try {
      await this.setMode(false, generation);
      if (!this.isCurrent(generation)) return this.uncertain(generation);
      const facts = this.io.readFacts();
      if (!validFacts(facts) || facts.isRecording || facts.statusRecording) {
        return this.uncertain(generation, message);
      }
      const outcome = classify(facts, generation);
      return { ...outcome, message };
    } catch {
      return this.uncertain(generation, message);
    }
  }

  private readOutcome(generation: number): NativeCaptureOutcome {
    try { return classify(this.io.readFacts(), generation); }
    catch { return this.uncertain(generation); }
  }

  private async setMode(enabled: boolean, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    this.mode = 'unknown';
    await this.io.setRecordingEnabled(enabled);
    if (this.isCurrent(generation)) this.mode = enabled ? 'enabled' : 'disabled';
  }

  private uncertain(generation: number, message?: string): NativeCaptureOutcome {
    return { state: 'uncertain', canResume: false, generation, ...(message ? { message } : {}) };
  }
}
