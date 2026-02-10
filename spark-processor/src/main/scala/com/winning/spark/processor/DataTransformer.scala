package com.winning.spark.processor

import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.functions._
import com.winning.spark.config.{ProcessorConfig, TransformRule}

class DataTransformer extends DataProcessor {
  override def process(df: DataFrame, config: ProcessorConfig): DataFrame = {
    config.transformation.foldLeft(df) { (acc, rule) =>
      applyTransform(acc, rule)
    }
  }
  
  private def applyTransform(df: DataFrame, rule: TransformRule): DataFrame = {
    rule.`type` match {
      case "add_column" =>
        df.withColumn(rule.name, expr(rule.value))
      case "rename" =>
        df.withColumnRenamed(rule.name, rule.value)
      case "drop" =>
        df.drop(rule.name)
      case _ => 
        println(s"Unknown transformation type: ${rule.`type`}")
        df
    }
  }
}
