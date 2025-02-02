import ipaddr from "ipaddr.js";

const BLOCKED_SUBNETS = [
  ["0.0.0.0", 8, 4],
  ["10.0.0.0", 8, 4],
  ["100.64.0.0", 10, 4],
  ["127.0.0.0", 8, 4],
  ["169.254.0.0", 16, 4],
  ["172.16.0.0", 12, 4],
  ["192.0.0.0", 24, 4],
  ["192.0.2.0", 24, 4],
  ["192.88.99.0", 24, 4],
  ["192.168.0.0", 16, 4],
  ["198.18.0.0", 15, 4],
  ["198.51.100.0", 24, 4],
  ["203.0.113.0", 24, 4],
  ["224.0.0.0", 4, 4],
  ["233.252.0.0", 24, 4],
  ["240.0.0.0", 4, 4],
  ["255.255.255.255", 32, 4],
  ["::", 128, 6],
  ["::1", 128, 6],
  ["::ffff:0:0", 96, 6],
  ["::ffff:0:0:0", 96, 6],
  ["64:ff9b::", 96, 6],
  ["64:ff9b:1::", 48, 6],
  ["100::", 64, 6],
  ["2001:0000::", 32, 6],
  ["2001:20::", 28, 6],
  ["2001:db8::", 32, 6],
  ["2002::", 16, 6],
  ["fc00::", 7, 6],
  ["fe80::", 10, 6],
  ["fe80::", 64, 6],
  ["ff00::", 8, 6],
] satisfies [string, number, 4 | 6][];
export class IpBlockList {
  private subnets: {
    ipv4: [ipaddr.IPv4, number][];
    ipv6: [ipaddr.IPv6, number][];
  } = {
    ipv4: [],
    ipv6: [],
  };
  private _rules: string[] = [];

  public get rules() {
    return Object.freeze(this._rules);
  }

  public addSubnet(ip: string, prefix: number, _version?: `ipv${4 | 6}`) {
    const [addr, subnet] = ipaddr.parseCIDR(`${ip}/${prefix}`);
    this.subnets[addr.kind()].push([addr as never, subnet]);
    this._rules.push(`Subnet ${addr.toNormalizedString()}/${subnet}`);
    return this;
  }

  public check(ip: string, _version?: `ipv${4 | 6}`) {
    const parsed = ipaddr.parse(ip);
    const matchingTypeSubnets = this.subnets[parsed.kind()];

    return matchingTypeSubnets.some((subnet) => parsed.match(subnet));
  }

  public getMatchingSubnets(ip: string) {
    const parsed = ipaddr.parse(ip);
    const matchingTypeSubnets = this.subnets[parsed.kind()];

    return matchingTypeSubnets.filter((subnet) => parsed.match(subnet));
  }
}

export const BLOCKED_IPS_FILTER = new IpBlockList();
for (const [ip, prefix, v] of BLOCKED_SUBNETS) {
  BLOCKED_IPS_FILTER.addSubnet(ip, prefix, `ipv${v}`);
}
