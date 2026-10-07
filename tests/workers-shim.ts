// Only for Node unit tests. Integration tests execute the real Worker in workerd.
export class WorkerEntrypoint {}
export class DurableObject {
  constructor(
    protected ctx: unknown,
    protected env: unknown,
  ) {}
}
