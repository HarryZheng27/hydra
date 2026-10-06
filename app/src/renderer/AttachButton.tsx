import { useState, type CSSProperties } from 'react';
import { attach } from './contextBus';
import { newAttachment, MAX_ATTACHMENTS, type Attachment } from './attachments';

/**
 * Claude desktop's "Attach as context" button, shown over a selection. Mouse-down is cancelled so the click doesn't
 * collapse the selection first; the caller clears the selection after.
 */
export function AttachButton({ chatId, item, style, onDone }: { chatId: string; item: Pick<Attachment, 'source' | 'label' | 'tab'> & { text: string }; style?: CSSProperties; onDone(): void }) {
  const [full, setFull] = useState(false);
  const click = () => {
    const made = newAttachment(item);
    if (made && !attach(chatId, made)) { setFull(true); return; }
    onDone();
  };
  return (
    <button className="attach-context" style={style} onMouseDown={event => event.preventDefault()} onClick={click} title={full ? `A message takes at most ${MAX_ATTACHMENTS} attachments` : 'Add the selection to your next message'}>
      {full ? `At most ${MAX_ATTACHMENTS} attachments` : 'Attach as context'}
    </button>
  );
}
