const paths: Record<string, string> = {
  sidebar: 'M3 4.5h14v11H3zM7.5 4.5v11',
  plus: 'M10 4v12M4 10h12',
  search: 'M8.5 3.5a5 5 0 1 1 0 10a5 5 0 0 1 0-10zM12.2 12.2L16.5 16.5',
  folder: 'M2.5 5.5h5l1.5 1.5h8.5v8.5h-15z',
  // A gear: eight teeth and a center hole.
  settings: 'M15.75 8.67L17.5 8.75L17.5 11.25L15.75 11.33L15.01 13.12L16.18 14.42L14.42 16.18L13.12 15.01L11.33 15.75L11.25 17.5L8.75 17.5L8.67 15.75L6.88 15.01L5.58 16.18L3.82 14.42L4.99 13.12L4.25 11.33L2.5 11.25L2.5 8.75L4.25 8.67L4.99 6.88L3.82 5.58L5.58 3.82L6.88 4.99L8.67 4.25L8.75 2.5L11.25 2.5L11.33 4.25L13.12 4.99L14.42 3.82L16.18 5.58L15.01 6.88ZM10 7.6a2.4 2.4 0 1 1 0 4.8a2.4 2.4 0 0 1 0-4.8z',
  chevron: 'M7.5 5l5 5l-5 5',
  close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  clone: 'M6 3.5v9M6 12.5a2 2 0 1 0 0 4a2 2 0 0 0 0-4zM14 7.5a2 2 0 1 0 0-4a2 2 0 0 0 0 4zM14 7.5c0 3-8 2-8 5',
  arrowUp: 'M10 15.5v-11M5.5 9l4.5-4.5L14.5 9',
  stop: 'M6.5 6.5h7v7h-7z',
  chevronDown: 'M6 8l4 4l4-4',
  check: 'M4.5 10.5l3.5 3.5l7.5-8',
  terminal: 'M3.5 4.5h13v11h-13zM6.5 8.5l2 1.5l-2 1.5M10.5 12.5h3',
  diff: 'M6 3.5v6M3 6.5h6M3.5 14.5h6M12.5 3.5h4v13h-4',
};

/** A small line icon, drawn with the current text color. */
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
