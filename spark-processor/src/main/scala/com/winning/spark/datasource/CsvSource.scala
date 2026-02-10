package com.winning.spark.datasource

import org.apache.spark.sql.{DataFrame, SparkSession}
import com.winning.spark.config.DatasourceConfig

class CsvSource extends DataSource {
  override def read(spark: SparkSession, config: DatasourceConfig): DataFrame = {
    val reader = spark.read
      .option("header", "true")
      .option("inferSchema", "true")
    
    config.options.foreach { case (key, value) =>
      reader.option(key, value)
    }
    
    reader.csv(config.path)
  }
}
