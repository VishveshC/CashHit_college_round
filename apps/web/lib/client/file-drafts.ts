export type FileDraft = { id: string; bound?: boolean };
export type FileDraftMap<T extends FileDraft = FileDraft> = Record<number, T[]>;

export function stagePrivateFile<T extends FileDraft>(files: FileDraftMap<T>, milestoneIndex: number, uploaded: T): FileDraftMap<T> {
  const current = files[milestoneIndex] ?? [];
  return {
    ...files,
    [milestoneIndex]: [
      ...current.filter((file) => file.id !== uploaded.id),
      { ...uploaded, bound: false } as T,
    ],
  };
}

export function markPrivateFileVerified<T extends FileDraft>(files: FileDraftMap<T>, milestoneIndex: number, fileId: string): FileDraftMap<T> {
  return {
    ...files,
    [milestoneIndex]: (files[milestoneIndex] ?? []).map((file) => file.id === fileId ? { ...file, bound: true } as T : file),
  };
}
