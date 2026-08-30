import { FileOverview, ProjectOverview, ProjectFeature } from '../shared/types'
import {
  runFileOverview,
  runProjectOverview,
  runFeatureResolution,
  runFeatureDetection,
  invalidateFileArtifacts
} from './ai/service'

/** Overview service: public IPC-facing entry points. */
export async function fileOverviewOp(relPath: string, force?: boolean): Promise<FileOverview> {
  return runFileOverview(relPath, force)
}

export function invalidateFileOverview(relPath: string): void {
  invalidateFileArtifacts(relPath)
}

export async function projectOverviewOp(force?: boolean): Promise<ProjectOverview> {
  return runProjectOverview(force)
}

export async function featureResolutionOp(name: string, hints: string[]): Promise<ProjectFeature> {
  return runFeatureResolution(name, hints)
}

export async function featureDetectionOp(force?: boolean): Promise<ProjectFeature[]> {
  return runFeatureDetection(force)
}