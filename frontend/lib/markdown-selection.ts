export interface TextareaEdit {
   value: string;
   selectionStart: number;
   selectionEnd: number;
}

export function getTextareaSelectionRect(textarea: HTMLTextAreaElement): DOMRect | null {
   const { selectionStart, selectionEnd } = textarea;
   if (selectionStart === selectionEnd) return null;

   const style = window.getComputedStyle(textarea);
   const textareaRect = textarea.getBoundingClientRect();

   const mirror = document.createElement('div');
   mirror.setAttribute('aria-hidden', 'true');
   mirror.style.position = 'fixed';
   mirror.style.top = `${textareaRect.top}px`;
   mirror.style.left = `${textareaRect.left}px`;
   mirror.style.width = `${textareaRect.width}px`;
   mirror.style.height = `${textareaRect.height}px`;
   mirror.style.visibility = 'hidden';
   mirror.style.pointerEvents = 'none';
   mirror.style.overflow = 'hidden';
   mirror.style.zIndex = '-1';
   mirror.style.whiteSpace = 'pre-wrap';
   mirror.style.wordWrap = 'break-word';

   const copyProps = [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'lineHeight',
      'letterSpacing',
      'textTransform',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
      'boxSizing',
   ] as const;

   for (const prop of copyProps) {
      mirror.style.setProperty(prop, style.getPropertyValue(prop));
   }

   const content = document.createElement('div');
   content.style.marginTop = `-${textarea.scrollTop}px`;

   const before = textarea.value.slice(0, selectionStart);
   const selected = textarea.value.slice(selectionStart, selectionEnd) || '.';
   const after = textarea.value.slice(selectionEnd);

   content.append(document.createTextNode(before));
   const marker = document.createElement('span');
   marker.textContent = selected;
   content.append(marker);
   content.append(document.createTextNode(after));
   mirror.append(content);

   document.body.appendChild(mirror);
   const markerRect = marker.getBoundingClientRect();
   document.body.removeChild(mirror);

   return markerRect;
}

export function applyTextareaWrap(
   value: string,
   selectionStart: number,
   selectionEnd: number,
   open: string,
   close: string,
   placeholder: string
): TextareaEdit {
   const selected = value.slice(selectionStart, selectionEnd);
   const beforeStart = selectionStart - open.length;
   const afterEnd = selectionEnd + close.length;

   if (
      beforeStart >= 0 &&
      value.slice(beforeStart, selectionStart) === open &&
      value.slice(selectionEnd, afterEnd) === close
   ) {
      const nextValue = value.slice(0, beforeStart) + selected + value.slice(afterEnd);
      return {
         value: nextValue,
         selectionStart: beforeStart,
         selectionEnd: beforeStart + selected.length,
      };
   }

   const inner = selected || placeholder;
   const wrapped = `${open}${inner}${close}`;
   const nextValue = value.slice(0, selectionStart) + wrapped + value.slice(selectionEnd);
   return {
      value: nextValue,
      selectionStart: selectionStart + open.length,
      selectionEnd: selectionStart + open.length + inner.length,
   };
}

export function applyTextareaLink(
   value: string,
   selectionStart: number,
   selectionEnd: number
): TextareaEdit {
   const selected = value.slice(selectionStart, selectionEnd) || 'link';
   const url = 'https://';
   const openBracket = selectionStart > 0 && value[selectionStart - 1] === '[';
   const linkTail = value.slice(selectionEnd);
   const linkMatch = linkTail.match(/^\]\([^)]*\)/);

   if (openBracket && linkMatch) {
      const closeIndex = selectionEnd + linkMatch[0].length;
      const linkStart = selectionStart - 1;
      const nextValue = value.slice(0, linkStart) + selected + value.slice(closeIndex);
      return {
         value: nextValue,
         selectionStart: linkStart,
         selectionEnd: linkStart + selected.length,
      };
   }

   const wrapped = `[${selected}](${url})`;
   const nextValue = value.slice(0, selectionStart) + wrapped + value.slice(selectionEnd);
   const urlStart = selectionStart + 1 + selected.length + 2;
   return {
      value: nextValue,
      selectionStart: urlStart,
      selectionEnd: urlStart + url.length,
   };
}

export function commitTextareaEdit(
   textarea: HTMLTextAreaElement,
   edit: TextareaEdit
): void {
   textarea.value = edit.value;
   textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
   textarea.dispatchEvent(new Event('input', { bubbles: true }));
   textarea.focus();
}
