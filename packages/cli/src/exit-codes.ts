/**
 * One definition, because these are a contract with whatever script is calling the CLI. They were
 * previously declared per command file, where `2` had picked up two different names.
 */
export const EXIT_OK = 0

/** The command ran and the answer was no: not found, refused, unreachable, rejected token. */
export const EXIT_FAILED = 1

/** The command was malformed and never ran — bad flag, missing argument, unusable value. */
export const EXIT_USAGE = 2
