export interface DbQueryResult {
  rows: any[];
  columns?: string[];
}

export interface DbConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}
