package com.winning.spark.datasource

import com.winning.spark.config.DatasourceConfig

object SourceFactory {
  def create(config: DatasourceConfig): DataSource = {
    config.`type`.toLowerCase match {
      case "json" => new JsonSource()
      case "csv" => new CsvSource()
      case "parquet" => new ParquetSource()
      case _ => throw new IllegalArgumentException(s"Unsupported datasource type: ${config.`type`}")
    }
  }
}
