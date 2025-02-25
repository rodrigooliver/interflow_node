export class RateLimiter {
  constructor(maxRequests, timeWindow) {
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
    this.requests = new Map(); // host -> [{timestamp}]
  }

  async canMakeRequest(host) {
    if (!this.requests.has(host)) {
      this.requests.set(host, []);
    }

    const now = Date.now();
    const requests = this.requests.get(host);
    
    // Remover requisições antigas
    const validRequests = requests.filter(
      timestamp => now - timestamp < this.timeWindow
    );
    
    this.requests.set(host, validRequests);

    if (validRequests.length >= this.maxRequests) {
      return false;
    }

    validRequests.push(now);
    return true;
  }
} 