declare module "promise.try" {
  interface PromiseTry {
    <T>(fn: () => T | PromiseLike<T>): Promise<T>;
    shim(): void;
  }
  const promiseTry: PromiseTry;
  export default promiseTry;
}
