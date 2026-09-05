const ISO_DATE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\D.*)?$/;
const LOCAL_DATE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\D.*)?$/;

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function inferDateOrder(values) {
  let evidence = null;
  for (const value of values) {
    const match = String(value ?? "")
      .trim()
      .match(LOCAL_DATE);
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    const rowEvidence = first > 12 ? "dmy" : second > 12 ? "mdy" : null;
    if (rowEvidence && evidence && rowEvidence !== evidence) return "conflict";
    if (rowEvidence) evidence = rowEvidence;
  }
  return evidence;
}

export function normalizeImportDate(
  value,
  selectedOrder = "auto",
  inferredOrder = null,
) {
  const text = String(value ?? "").trim();
  if (!text) return { value: "", error: "Date is blank." };
  let match = text.match(ISO_DATE);
  let year, month, day;
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = text.match(LOCAL_DATE);
    if (!match)
      return { value: "", error: `Date “${text}” is not recognized.` };
    const order = selectedOrder === "auto" ? inferredOrder : selectedOrder;
    if (!order || order === "conflict")
      return {
        value: "",
        error: `Date “${text}” is ambiguous. Choose its format above.`,
      };
    year = Number(match[3]);
    month = Number(match[order === "mdy" ? 1 : 2]);
    day = Number(match[order === "mdy" ? 2 : 1]);
  }
  if (!validDate(year, month, day))
    return { value: "", error: `Date “${text}” is not a real calendar date.` };
  return {
    value: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
    error: "",
  };
}
