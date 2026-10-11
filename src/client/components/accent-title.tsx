"use client";

// A SCREEN TITLE WITH ITS LAST WORD LIT — "What do you want to verify?",
// "Research Library" (the Figma treatment). Purely typographic: the text
// is the dictionary's own, split on its last space, so EN and RU get the
// same emphasis without a second copy of the title. A one-word title is
// rendered plain.
export function AccentTitle({ text }: { text: string }) {
  const at = text.lastIndexOf(" ");
  if (at <= 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)} <span className="accent">{text.slice(at + 1)}</span>
    </>
  );
}
