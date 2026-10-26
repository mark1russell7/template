// The import boundaries of the workspace (@mark1russell7/boundaries): another package is imported only
// through an entry of its package.json. Start the check with `pnpm check:boundaries`.
import { boundaries } from "@mark1russell7/boundaries";

export default boundaries(import.meta.dirname);
