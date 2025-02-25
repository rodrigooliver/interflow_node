export class ConnectionPool {
  constructor({ maxSize, create, validate, destroy }) {
    this.maxSize = maxSize;
    this.create = create;
    this.validate = validate;
    this.destroy = destroy;
    this.pool = [];
    this.inUse = new Set();
  }

  async acquire() {
    // Tentar reutilizar conexão existente
    while (this.pool.length > 0) {
      const conn = this.pool.pop();
      if (await this.validate(conn)) {
        this.inUse.add(conn);
        return conn;
      } else {
        await this.destroy(conn);
      }
    }

    // Criar nova conexão se houver espaço
    if (this.inUse.size < this.maxSize) {
      const conn = await this.create();
      this.inUse.add(conn);
      return conn;
    }

    // Esperar por conexão disponível
    return new Promise((resolve) => {
      const checkPool = setInterval(async () => {
        if (this.pool.length > 0) {
          clearInterval(checkPool);
          resolve(await this.acquire());
        }
      }, 1000);
    });
  }

  async release(conn) {
    this.inUse.delete(conn);
    if (await this.validate(conn)) {
      this.pool.push(conn);
    } else {
      await this.destroy(conn);
    }
  }

  async drain() {
    // Esperar todas as conexões serem liberadas
    while (this.inUse.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async clear() {
    for (const conn of this.pool) {
      await this.destroy(conn);
    }
    this.pool = [];
  }
} 