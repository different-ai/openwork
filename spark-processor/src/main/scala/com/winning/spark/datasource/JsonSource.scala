package com.winning.spark.datasource

import org.apache.spark.sql.{DataFrame, SparkSession}
import com.winning.spark.config.DatasourceConfig

class JsonSource extends DataSource {
  override def read(spark: SparkSession, config: DatasourceConfig): DataFrame = {
    val reader = spark.read.option("multiline", "true")
    
    config.options.foreach { case (key, value) =>
      reader.option(key, value)
    }
    
    reader.json(config.path)
  }
}
