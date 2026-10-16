/**
 * Compile-time contract for `buildStagedPipeline`'s two return shapes.
 *
 * This file contains no runtime code and is imported by nothing — `npx tsc -b`
 * IS the test. It exists because the thing that can break here is unobservable
 * at runtime from the builder's side: the builder decides which shape to return
 * from whether `stopAfter`/`resume` are DEFINED, and if the overloads promise
 * `StagedBuildProgress` to a call where both may be `undefined` at runtime, the
 * caller reads `.complete` off the historic result, gets `undefined`, and treats
 * a finished build as unfinished — forever, in a polling driver.
 *
 * So: the type rule and the runtime rule must be the same rule, and the
 * `@ts-expect-error` lines below fail the build if the types ever loosen.
 */
import type { StagedBuildOptions, StagedBuildProgress, StagedBuildResult, StagedStopAfter } from './staged-build';
import { buildStagedPipeline } from './staged-build';

// A caller's own options, WITHOUT the continuation keys — the shape every
// existing call site has. Declaring it as a bare `StagedBuildOptions` would
// make even the regular call ambiguous, since that type's optional
// `resume`/`stopAfter` are `T | undefined` rather than absent.
declare const base: Omit<StagedBuildOptions, 'resume' | 'stopAfter'>;
declare const phase: StagedStopAfter;
declare const maybePhase: StagedStopAfter | undefined;

// A regular caller — neither option — keeps the historic result.
export async function regular(): Promise<StagedBuildResult | null> {
  return buildStagedPipeline(base);
}

// A defined stop boundary is a continuation call.
export async function stopping(): Promise<StagedBuildProgress | null> {
  return buildStagedPipeline({ ...base, stopAfter: phase });
}

// So is a checkpoint, including the empty "nothing done yet" one — which is how
// a driver that cannot name a boundary still asks for the progress wrapper.
export async function resuming(): Promise<StagedBuildProgress | null> {
  return buildStagedPipeline({ ...base, resume: {} });
}

// A possibly-undefined phase must NOT type-check as a continuation call: at
// runtime it may be neither, and the caller would be handed the wrong shape.
export async function dynamicPhaseIsRejected(): Promise<void> {
  // @ts-expect-error `stopAfter` may be undefined — narrow it, or pass `resume`.
  const progress: StagedBuildProgress | null = await buildStagedPipeline({ ...base, stopAfter: maybePhase });
  void progress;
}

// Narrowing is the fix, and it must keep working.
export async function dynamicPhaseNarrowed(): Promise<StagedBuildProgress | StagedBuildResult | null> {
  return maybePhase === undefined
    ? buildStagedPipeline({ ...base, resume: {} })
    : buildStagedPipeline({ ...base, stopAfter: maybePhase });
}

// A continuation call never returns the bare historic shape.
export async function continuationIsNotTheBareResult(): Promise<void> {
  // @ts-expect-error a continuation call yields StagedBuildProgress, not StagedBuildResult.
  const bare: StagedBuildResult | null = await buildStagedPipeline({ ...base, stopAfter: phase });
  void bare;
}

// And a regular call never returns the progress wrapper.
export async function regularIsNotProgress(): Promise<void> {
  // @ts-expect-error a call with neither option yields StagedBuildResult, not StagedBuildProgress.
  const progress: StagedBuildProgress | null = await buildStagedPipeline(base);
  void progress;
}
