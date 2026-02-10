package com.winning.spark.datasource

import org.apache.spark.sql.{DataFrame, SparkSession}
import com.winning.spark.config.DatasourceConfig

class ParquetSource extends DataSource {
  override def read(spark: SparkSession, config: DatasourceConfig): DataFrame = {
    spark.read.parquet(config.path)
  }
}
