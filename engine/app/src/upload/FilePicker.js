/**
 * The browser's file dialog for files of the `accept` types, one or (`multiple`) several:
 * resolves with them, an empty list if none is chosen. Call it while handling a click (browsers
 * open the dialog only then).
 */
export function pickFiles(accept = '', { multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept, multiple, hidden: true });
    const done = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...input.files]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Calls `onFiles(files, event)` for the files dropped anywhere on the page, and `onOther(dataTransfer)`
 * for a drop with none in it: a path or a link (as some apps give a file), or files the browser may
 * not read (a sandboxed browser, as Ubuntu's Firefox snap outside the home folder). Every drag over
 * the page is taken (window, capture phase: before anything else sees it), else the browser opens
 * what is dropped in place of the page; none starts on the page (a picture, a link: nothing here
 * is for dragging that way). `mark` gets the class "dropping" while something is dragged over it.
 */
export function dropFiles(mark, onFiles, onOther = () => {}) {
  let depth = 0; // elements entered and not yet left: back to 0, the drag has left the page
  const show = (on) => mark.classList.toggle('dropping', on);
  const on = (type, fn) => window.addEventListener(type, fn, true);
  on('dragstart', (e) => e.preventDefault());
  on('dragenter', (e) => {
    e.preventDefault();
    depth++;
    show(true);
  });
  on('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      show(false);
    }
  });
  on('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  on('drop', (e) => {
    e.preventDefault();
    depth = 0;
    show(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) onFiles(files, e);
    else onOther(e.dataTransfer);
  });
}
