export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export class NotFound extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = "NotFound";
  }
}

export class Conflict extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = "Conflict";
  }
}

export class InvalidInput extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInput";
  }
}
