export interface FormatOptions {
  readonly indentWidth: number;
  readonly useTabs: boolean;
  readonly lineWidth: number;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  indentWidth: 4,
  useTabs: false,
  lineWidth: 100,
};

export function resolveFormatOptions(
  partial: Partial<FormatOptions> = {},
): FormatOptions {
  return {
    indentWidth: partial.indentWidth ?? DEFAULT_FORMAT_OPTIONS.indentWidth,
    useTabs: partial.useTabs ?? DEFAULT_FORMAT_OPTIONS.useTabs,
    lineWidth: partial.lineWidth ?? DEFAULT_FORMAT_OPTIONS.lineWidth,
  };
}

export function indentUnit(options: FormatOptions): string {
  return options.useTabs ? "\t" : " ".repeat(Math.max(0, options.indentWidth));
}
