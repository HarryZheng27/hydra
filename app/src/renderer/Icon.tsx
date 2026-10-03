const paths: Record<string, string> = {
  sidebar: 'M3 4.5h14v11H3zM7.5 4.5v11',
  plus: 'M10 4v12M4 10h12',
  search: 'M8.5 3.5a5 5 0 1 1 0 10a5 5 0 0 1 0-10zM12.2 12.2L16.5 16.5',
  folder: 'M2.5 5.5h5l1.5 1.5h8.5v8.5h-15z',
  settings: 'M10 7a3 3 0 1 1 0 6a3 3 0 0 1 0-6zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4',
  chevron: 'M7.5 5l5 5l-5 5',
  close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  clone: 'M6 3.5v9M6 12.5a2 2 0 1 0 0 4a2 2 0 0 0 0-4zM14 7.5a2 2 0 1 0 0-4a2 2 0 0 0 0 4zM14 7.5c0 3-8 2-8 5',
  arrowUp: 'M10 15.5v-11M5.5 9l4.5-4.5L14.5 9',
  stop: 'M6.5 6.5h7v7h-7z',
};

/** A small line icon, drawn with the current text color. */
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
