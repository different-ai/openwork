package com.winning.spark.datasource

import org.apache.spark.sql.{DataFrame, SparkSession}
import org.apache.spark.sql.types.StructType
import com.winning.spark.config.DatasourceConfig

trait DataSource {
  def read(spark: SparkSession, config: DatasourceConfig): DataFrame
  def getSchema: Option[StructType] = None
}
