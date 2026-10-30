import React from 'react';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { InlineCommentCard } from './InlineCommentCard';
import { InlineCommentInput } from './InlineCommentInput';
import { useInlineCommentController } from './useInlineCommentController';
import { isWholeFileComment } from './wholeFileComment';

const WHOLE_FILE_RANGE = { start: 0, end: 0 };

/**
 * Comments on a file as a whole, written from its header. The header shows the
 * trigger. The saved comments render under the header, where the line
 * comments' editor would, so the file's own diff never moves. The editor goes
 * inside a sticky header: opened from a file scrolled far down, it shows under
 * the header on screen instead of at the file's top out of view.
 * Files view passes `source: 'file'`, so its comments sit with its line comments.
 */
export function useWholeFileComment({
  fileLabel,
  origin,
  source = 'diff',
}: {
  fileLabel: string;
  origin?: DiffCommentOrigin;
  source?: 'diff' | 'file';
}) {
  const controller = useInlineCommentController<{ start: number; end: number }>({
    source,
    fileLabel,
    language: '',
    origin,
    getCodeForRange: () => '',
    toStoreRange: () => ({ startLine: 0, endLine: 0 }),
    fromDraftRange: () => WHOLE_FILE_RANGE,
  });
  const { drafts, selection, setSelection, commentText, setCommentText, editingDraftId, saveComment, cancel, startEdit, deleteDraft } = controller;
  const fileDrafts = React.useMemo(() => drafts.filter(isWholeFileComment), [drafts]);

  // Files view keeps one instance across files: an open editor belongs to the file it was opened on.
  React.useEffect(() => {
    cancel();
  }, [fileLabel, cancel]);

  // The header button opens the editor and, pressed again, closes it unsaved.
  const toggle = React.useCallback(() => {
    if (selection) cancel();
    else setSelection(WHOLE_FILE_RANGE);
  }, [selection, cancel, setSelection]);

  const shownDrafts = fileDrafts.filter((draft) => draft.id !== editingDraftId);
  const cards = shownDrafts.length > 0 ? (
    <div className="flex flex-col gap-2 px-3 py-2">
      {shownDrafts.map((draft) => (
        <InlineCommentCard
          key={draft.id}
          draft={draft}
          onEdit={() => startEdit(draft)}
          onDelete={() => deleteDraft(draft)}
        />
      ))}
    </div>
  ) : null;

  const editor = selection ? (
    <div className="px-3 py-2">
      <InlineCommentInput
        initialText={commentText}
        onTextChange={setCommentText}
        onSave={(text) => saveComment(text, WHOLE_FILE_RANGE)}
        onCancel={cancel}
        fileLabel={fileLabel}
        isEditing={editingDraftId !== null}
        band={false}
      />
    </div>
  ) : null;

  return { toggle, isOpen: selection !== null, cards, editor };
}
