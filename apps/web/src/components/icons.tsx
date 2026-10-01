// Inline stroke glyphs. Every status carries one, so it reads without colour.
type P = { size?: number; label?: string };
const S = ({ size = 14, label, children }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} aria-label={label} role={label ? "img" : undefined}>
    {children}
  </svg>
);
export const Check = (p: P) => <S {...p}><path d="M3 8.5l3.2 3L13 4.5" /></S>;
export const Stop = (p: P) => <S {...p}><path d="M5.5 1.8h5l3.7 3.7v5l-3.7 3.7h-5l-3.7-3.7v-5z" /><path d="M8 5v3.6" /><path d="M8 11.2v.1" /></S>;
export const Eye = (p: P) => <S {...p}><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="1.8" /></S>;
export const Dashed = (p: P) => <S {...p}><circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 2.2" /></S>;
export const Missing = (p: P) => <S {...p}><circle cx="8" cy="8" r="5.5" /><path d="M4.3 11.7l7.4-7.4" /></S>;
export const Conflict = (p: P) => <S {...p}><path d="M2.5 5.5h10" /><path d="M10 3l2.5 2.5L10 8" /><path d="M13.5 10.5h-10" /><path d="M6 8l-2.5 2.5L6 13" /></S>;
export const Lock = (p: P) => <S {...p}><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5.2a2.5 2.5 0 015 0V7" /></S>;
export const Doc = (p: P) => <S {...p}><path d="M4 1.8h5.2L12 4.6v9.6H4z" /><path d="M9 1.8v3h3" /></S>;
export const Upload = (p: P) => <S {...p}><path d="M8 10.5V2.5" /><path d="M4.8 5.7L8 2.5l3.2 3.2" /><path d="M2.5 13.5h11" /></S>;
export const Download = (p: P) => <S {...p}><path d="M8 2.5v8" /><path d="M4.8 7.3L8 10.5l3.2-3.2" /><path d="M2.5 13.5h11" /></S>;
export const Chevron = (p: P) => <S {...p}><path d="M6 3.5L10.5 8 6 12.5" /></S>;
export const Bookmark = (p: P) => <S {...p}><path d="M4 2h8v12l-4-3-4 3z" /></S>;
export const Cross = (p: P) => <S {...p}><path d="M4 4l8 8" /><path d="M12 4l-8 8" /></S>;
export const Spinner = (p: P) => <S {...p}><circle cx="8" cy="8" r="5.5" strokeOpacity={0.35} /><path d="M8 2.5a5.5 5.5 0 015.5 5.5" /></S>;
export const Retry = (p: P) => <S {...p}><path d="M2.8 8a5.2 5.2 0 019.1-3.4" /><path d="M12.3 2v2.9H9.4" /><path d="M13.2 8a5.2 5.2 0 01-9.1 3.4" /><path d="M3.7 14v-2.9h2.9" /></S>;
export const Pencil = (p: P) => <S {...p}><path d="M10.5 2.5l3 3L6 13H3v-3z" /></S>;
