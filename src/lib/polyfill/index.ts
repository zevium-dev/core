declare global {
  interface PromiseConstructor {
    try<T>(fn: () => PromiseLike<T> | T): Promise<T>;
  }
}

if (!Object.prototype.hasOwnProperty.call(Promise.prototype, "try")) {
  Promise.try = function <T>(fn: () => PromiseLike<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        resolve(fn());
      } catch (e) {
        if (e instanceof Error) {
          reject(e);
        } else {
          reject(new Error(String(e)));
        }
      }
    });
  };
}

export {};
